"use strict";
/**
 * PATCH /api/tournaments/:tournamentId/complete  ("Mark as completed")
 *
 * Nothing in the live flows ever moved a tournament to `completed` (the only
 * writer targeted root fields the schema no longer declares, so Mongoose dropped
 * it). This endpoint is how a manager closes a tournament by hand. Contract:
 *   - only an owner (manager in managerId / their club admin / superadmin)
 *   - never leaks across clubs
 *   - every sport track -> currentStage "completed", written per-sport
 *   - can't complete a tournament that hasn't started; idempotent otherwise
 */
const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const {
  startTestApp,
  stopTestApp,
  superAdminToken,
  clearDatabase,
} = require("./setup");

const Tournament = require("../../src/modules/tournaments/models/Tournament");
const Role = require("../../src/modules/identity/models/Role");
const Permission = require("../../src/modules/identity/models/Permission");
const { Manager } = require("../../src/modules/identity/models/ClubManager");
const { setCurrentStage, setAllTracksStage } = require("../../utils/sportTrackUtils");

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);

beforeEach(async () => {
  await clearDatabase();
  // requirePermission("tournament:manage") needs a Role graph for managers.
  const p = await Permission.create({
    key: "tournament:manage",
    name: "Manage tournament",
    module: "tournament",
    action: "manage",
  });
  await Role.create({ name: "Manager", slug: "manager", authorityLevel: 2, permissions: [p._id] });
});

const oid = () => new mongoose.Types.ObjectId();

async function makeManager(clubId, n) {
  const m = await Manager.create({
    name: `Mgr ${n}`,
    email: `mgr${n}@test.local`,
    password: "x".repeat(12),
    clubId,
  });
  const token = jwt.sign({ id: String(m._id), role: "manager" }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
  return { manager: m, token };
}

const track = (name, stage) => ({
  sportId: oid(),
  sportName: name,
  tournamentLevel: "unranked",
  categories: [{ name: "Open", fee: 0 }],
  currentStage: stage,
});

function makeTournament({ clubId, managerIds, startDate = "2020-01-01", stages = ["group_stage", "registration"] }) {
  return Tournament.create({
    title: "Closing Cup",
    startDate,
    endDate: "2020-01-02",
    clubId,
    managerId: managerIds,
    sports: stages.map((s, i) => track(`Sport${i}`, s)),
  });
}

const stagesOf = async (id) =>
  (await Tournament.findById(id).lean()).sports.map((s) => s.currentStage);

const complete = (id, token) =>
  request(app).patch(`/api/tournaments/${id}/complete`).set("Authorization", token ? `Bearer ${token}` : "");

test("requires authentication", async () => {
  const t = await makeTournament({ clubId: oid(), managerIds: [] });
  const res = await complete(t._id);
  expect(res.status).toBe(401);
  expect(await stagesOf(t._id)).toEqual(["group_stage", "registration"]);
});

test("the owner completes every sport track", async () => {
  const club = oid();
  const { manager, token } = await makeManager(club, 1);
  const t = await makeTournament({ clubId: club, managerIds: [manager._id] });

  const res = await complete(t._id, token);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.tournament.sports.map((s) => s.currentStage)).toEqual(["completed", "completed"]);
  expect(await stagesOf(t._id)).toEqual(["completed", "completed"]);
});

test("writes the per-sport tracks, never a root currentStage/tournamentStatus", async () => {
  const club = oid();
  const { manager, token } = await makeManager(club, 1);
  const t = await makeTournament({ clubId: club, managerIds: [manager._id] });
  await complete(t._id, token);

  const raw = await Tournament.collection.findOne({ _id: t._id });
  expect(raw).not.toHaveProperty("currentStage");
  expect(raw).not.toHaveProperty("tournamentStatus");
  expect(raw.sports.every((s) => s.currentStage === "completed")).toBe(true);
});

test("is idempotent", async () => {
  const club = oid();
  const { manager, token } = await makeManager(club, 1);
  const t = await makeTournament({ clubId: club, managerIds: [manager._id], stages: ["completed"] });

  const res = await complete(t._id, token);
  expect(res.status).toBe(200);
  expect(res.body.alreadyCompleted).toBe(true);
});

test("a same-club manager who is not an owner is refused", async () => {
  const club = oid();
  const { manager: owner } = await makeManager(club, 1);
  const { token: otherToken } = await makeManager(club, 2); // same club, not in managerId
  const t = await makeTournament({ clubId: club, managerIds: [owner._id] });

  const res = await complete(t._id, otherToken);

  expect(res.status).toBe(403);
  expect(await stagesOf(t._id)).toEqual(["group_stage", "registration"]);
});

test("a manager from another club cannot complete it (and nothing changes)", async () => {
  const clubA = oid();
  const clubB = oid();
  const { manager: owner } = await makeManager(clubA, 1);
  const { token: outsider } = await makeManager(clubB, 2);
  const t = await makeTournament({ clubId: clubA, managerIds: [owner._id] });

  const res = await complete(t._id, outsider);

  expect([403, 404]).toContain(res.status);
  expect(await stagesOf(t._id)).toEqual(["group_stage", "registration"]);
});

test("refuses a tournament that has not started yet", async () => {
  const club = oid();
  const { manager, token } = await makeManager(club, 1);
  const t = await makeTournament({ clubId: club, managerIds: [manager._id], startDate: "2099-01-01" });

  const res = await complete(t._id, token);

  expect(res.status).toBe(409);
  expect(await stagesOf(t._id)).toEqual(["group_stage", "registration"]);
});

test("a malformed id is rejected", async () => {
  const club = oid();
  const { token } = await makeManager(club, 1);
  const res = await complete("not-an-id", token);
  expect(res.status).toBe(400);
});

test("a superadmin can complete any tournament", async () => {
  const t = await makeTournament({ clubId: oid(), managerIds: [oid()] });
  const res = await complete(t._id, superAdminToken());
  expect(res.status).toBe(200);
  expect(await stagesOf(t._id)).toEqual(["completed", "completed"]);
});

describe("stage helpers", () => {
  test("setCurrentStage(...,'completed') completes only that sport's track", async () => {
    const t = await makeTournament({ clubId: oid(), managerIds: [] });
    await setCurrentStage(t._id, t.sports[0].sportId, "completed");
    expect(await stagesOf(t._id)).toEqual(["completed", "registration"]);
  });

  test("setAllTracksStage sets every track", async () => {
    const t = await makeTournament({ clubId: oid(), managerIds: [], stages: ["registration", "knockout", "group_stage"] });
    await setAllTracksStage(t._id, "completed");
    expect(await stagesOf(t._id)).toEqual(["completed", "completed", "completed"]);
  });
});

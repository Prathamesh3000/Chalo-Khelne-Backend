"use strict";
/**
 * GET /api/tournaments/summaries?ids=a,b,c
 *
 * Batch title/date lookup used by the manager notifications inbox. It replaced
 * one GET /api/tournaments/:id per tournament, whose 404s for deleted
 * tournaments flooded the console. Contract under test:
 *   - authenticated
 *   - returns only ids that exist; deleted / malformed ids are skipped (no 404)
 *   - club staff only see their own club's tournaments
 *   - capped, and not shadowed by the `/:id` catch-all route
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
const { Manager } = require("../../src/modules/identity/models/ClubManager");

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(clearDatabase);

const oid = () => new mongoose.Types.ObjectId();

async function makeTournament({ title, clubId, startDate = "2026-01-01", endDate = "2026-01-02" }) {
  return Tournament.create({
    title,
    startDate,
    endDate,
    clubId,
    sports: [{ sportId: oid(), sportName: "Carrom", categories: [{ name: "Open", fee: 0 }] }],
  });
}

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

const get = (ids, token) =>
  request(app)
    .get(`/api/tournaments/summaries?ids=${ids.join(",")}`)
    .set("Authorization", token ? `Bearer ${token}` : "");

test("requires authentication", async () => {
  const t = await makeTournament({ title: "A", clubId: oid() });
  const res = await request(app).get(`/api/tournaments/summaries?ids=${t._id}`);
  expect(res.status).toBe(401);
});

test("returns title and dates for ids that exist, skipping deleted and malformed ids", async () => {
  const keep = await makeTournament({ title: "Kept Cup", clubId: oid() });
  const deleted = oid(); // never created: stands in for a deleted tournament

  const res = await get([keep._id, deleted, "not-an-objectid"], superAdminToken());

  expect(res.status).toBe(200); // never a 404 for a missing id
  expect(res.body.success).toBe(true);
  expect(res.body.tournaments).toHaveLength(1);
  expect(res.body.tournaments[0]).toMatchObject({
    _id: String(keep._id),
    title: "Kept Cup",
    startDate: "2026-01-01",
    endDate: "2026-01-02",
  });
  // Only the summary fields leave the server (no sports, managers, whitelist…).
  expect(Object.keys(res.body.tournaments[0]).sort()).toEqual(
    ["_id", "endDate", "startDate", "title"]
  );
});

test("is not shadowed by the /:id route (no CastError / 'Tournament not found')", async () => {
  const res = await get([oid()], superAdminToken());
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, tournaments: [] });
});

test("empty ids returns an empty list", async () => {
  const res = await request(app)
    .get("/api/tournaments/summaries")
    .set("Authorization", `Bearer ${superAdminToken()}`);
  expect(res.status).toBe(200);
  expect(res.body.tournaments).toEqual([]);
});

test("rejects more than 100 ids", async () => {
  const ids = Array.from({ length: 101 }, () => String(oid()));
  const res = await get(ids, superAdminToken());
  expect(res.status).toBe(400);
});

test("club staff only get their own club's tournaments", async () => {
  const clubA = oid();
  const clubB = oid();
  const mine = await makeTournament({ title: "Club A Open", clubId: clubA });
  const theirs = await makeTournament({ title: "Club B Open", clubId: clubB });
  const { token } = await makeManager(clubA, 1);

  const res = await get([mine._id, theirs._id], token);

  expect(res.status).toBe(200);
  expect(res.body.tournaments.map((t) => t.title)).toEqual(["Club A Open"]);
});

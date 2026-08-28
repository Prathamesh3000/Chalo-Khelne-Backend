"use strict";
/**
 * Trap 6 — a subscription must not lapse in a way that wrecks an event that is
 * already underway.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS TRAP ACTUALLY IS, once Phase 3 landed
 * ─────────────────────────────────────────────────────────────────────────
 * The plan described this as "a trial lapses on finals day and live scoring
 * 403s mid-match". That is NO LONGER TRUE, and the first describe block below
 * exists to keep it that way: `tournament:score` and `tournament:manage` were
 * put in the FREE tier, so scoring, brackets and courts survive any lapse.
 *
 * What a lapse genuinely costs mid-event is narrower and less obvious:
 *
 *   referee:assign / referee:read  → cannot assign an official to a match
 *   booking:approve                → cannot admit a walk-in at the desk
 *   player:view_all                → cannot see the full entrant list
 *   payment:read / payment:approve → cannot take a fee at the desk
 *   tournament:export              → cannot print the draw or results
 *
 * Those are the keys that get grace, and only while a tournament is actually
 * in progress. Grace deliberately does NOT extend to creating the NEXT
 * tournament — finish what you started, then pay.
 */
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { startTestApp, stopTestApp, clearDatabase } = require("./setup");
const { authenticate } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/rbacMiddleware");
const { GRACE_KEYS } = require("../../utils/entitlements");

const Role = require("../../src/modules/identity/models/Role");
const Permission = require("../../src/modules/identity/models/Permission");
const User = require("../../src/modules/identity/models/User");
const Subscription = require("../../src/modules/billing/models/Subscription");
const Tournament = require("../../src/modules/tournaments/models/Tournament");

const FREE_TIER = [
  "tournament:read", "tournament:create", "tournament:update", "tournament:delete",
  "tournament:manage", "tournament:score", "booking:read", "player:read", "manager:read",
];
const SOLD = [
  "referee:assign", "referee:read", "booking:approve", "player:view_all",
  "payment:read", "payment:approve", "tournament:export",
];

const DAY = 24 * 60 * 60 * 1000;
let uniq = 0;
let probe;

beforeAll(async () => {
  await startTestApp();
  probe = express();
  const gate = (key) => {
    probe.get(`/p/${encodeURIComponent(key)}`, authenticate, requirePermission(key),
      (_req, res) => res.json({ ok: true }));
  };
  [...FREE_TIER, ...SOLD].forEach(gate);
});
afterAll(stopTestApp);

beforeEach(async () => {
  await clearDatabase();
  const ids = [];
  for (const key of [...FREE_TIER, ...SOLD]) {
    const [m, a] = key.split(":");
    ids.push((await Permission.create({ key, name: key, module: m, action: a }))._id);
  }
  // club_admin as Phase 3 leaves it: free tier only.
  const freeIds = [];
  for (const key of FREE_TIER) {
    freeIds.push((await Permission.findOne({ key }))._id);
  }
  await Role.create({ name: "Club Admin", slug: "club_admin", authorityLevel: 1, permissions: freeIds });
  expect(ids.length).toBe(FREE_TIER.length + SOLD.length);
});

async function makeClub() {
  uniq += 1;
  return User.create({
    name: `Club ${uniq}`, email: `grace-${uniq}-${Date.now()}@test.local`,
    password: "x", role: "ClubAdmin",
    dateOfBirth: new Date("1990-01-01"), sex: "male", mobile: "9999999999",
  });
}
const tokenFor = (u) => jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });
const can = (token, key) =>
  request(probe).get(`/p/${encodeURIComponent(key)}`).set("Authorization", `Bearer ${token}`)
    .then((r) => r.status === 200);

/** A lapsed subscription that held everything sold. */
const lapsed = (clubId, over = {}) =>
  Subscription.create({
    subjectId: clubId, subjectType: "club", planSlug: "pro",
    grantedPermissions: [...SOLD], pricePaidRupees: 300,
    status: "active", startsAt: new Date(Date.now() - 40 * DAY),
    expiresAt: new Date(Date.now() - 1000), ...over,
  });

/**
 * A tournament for this club that is happening right now.
 *
 * Dates are inserted as "YYYY-MM-DD" STRINGS because that is what the schema
 * declares and what the app stores — inserting Date objects here would make
 * the fixture pass against a query that fails in production.
 */
const ymd = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const runningTournament = (clubId) =>
  Tournament.collection.insertOne({
    clubId, title: "Finals Day",
    startDate: ymd(-1),
    endDate: ymd(1),
  });

// ═══════════════════════════════════════════════════════════════
// The standing guard: scoring is free and survives any lapse
// ═══════════════════════════════════════════════════════════════

describe("a lapse never touches core tournament running", () => {
  test("scoring and bracket management survive with NO subscription at all", async () => {
    const club = await makeClub();
    const token = tokenFor(club);

    expect(await can(token, "tournament:score")).toBe(true);
    expect(await can(token, "tournament:manage")).toBe(true);
    expect(await can(token, "tournament:read")).toBe(true);
    expect(await can(token, "booking:read")).toBe(true);
  });

  test("scoring survives an expired subscription, mid-tournament or not", async () => {
    const club = await makeClub();
    await lapsed(club._id);
    const token = tokenFor(club);

    expect(await can(token, "tournament:score")).toBe(true);
    expect(await can(token, "tournament:manage")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Grace — only during a running event, only for the keys that matter
// ═══════════════════════════════════════════════════════════════

describe("grace while a tournament is in progress", () => {
  test("without a running tournament, a lapse revokes the sold keys", async () => {
    const club = await makeClub();
    await lapsed(club._id);
    const token = tokenFor(club);

    for (const key of SOLD) {
      expect(await can(token, key)).toBe(false);
    }
  });

  test("WITH a running tournament, the mid-event keys keep working", async () => {
    const club = await makeClub();
    await lapsed(club._id);
    await runningTournament(club._id);
    const token = tokenFor(club);

    // The desk keeps functioning: officials, walk-ins, fees, the entrant list.
    expect(await can(token, "referee:assign")).toBe(true);
    expect(await can(token, "booking:approve")).toBe(true);
    expect(await can(token, "payment:approve")).toBe(true);
    expect(await can(token, "player:view_all")).toBe(true);
    expect(await can(token, "tournament:export")).toBe(true);
  });

  test("grace covers ONLY keys the lapsed plan actually held", async () => {
    const club = await makeClub();
    // They only ever bought referee access.
    await lapsed(club._id, { grantedPermissions: ["referee:assign", "referee:read"] });
    await runningTournament(club._id);
    const token = tokenFor(club);

    expect(await can(token, "referee:assign")).toBe(true);
    // Never bought, so grace cannot conjure it.
    expect(await can(token, "payment:approve")).toBe(false);
  });

  test("a club that NEVER subscribed gets no grace from someone else's event", async () => {
    const club = await makeClub();
    await runningTournament(club._id);
    const token = tokenFor(club);

    for (const key of SOLD) {
      expect(await can(token, key)).toBe(false);
    }
  });

  test("another club's running tournament grants nothing", async () => {
    const lapsedClub = await makeClub();
    const otherClub = await makeClub();
    await lapsed(lapsedClub._id);
    await runningTournament(otherClub._id); // not theirs

    expect(await can(tokenFor(lapsedClub), "referee:assign")).toBe(false);
  });

  test("a finished tournament grants nothing", async () => {
    const club = await makeClub();
    await lapsed(club._id);
    await Tournament.collection.insertOne({
      clubId: club._id, title: "Last month",
      startDate: ymd(-30),
      endDate: ymd(-20),
    });

    expect(await can(tokenFor(club), "referee:assign")).toBe(false);
  });

  test("a cancelled subscription gets no grace — cancelling is voluntary", async () => {
    const club = await makeClub();
    await lapsed(club._id, { status: "cancelled" });
    await runningTournament(club._id);

    expect(await can(tokenFor(club), "referee:assign")).toBe(false);
  });

  test("grace does NOT extend to starting the next tournament", async () => {
    const club = await makeClub();
    await lapsed(club._id, { grantedPermissions: [...SOLD, "tournament:bulk_register"] });
    await runningTournament(club._id);

    // bulk_register is not a mid-event key: finish this event, then pay.
    expect(GRACE_KEYS).not.toContain("tournament:bulk_register");
  });

  test("grace lapses once the event ends", async () => {
    const club = await makeClub();
    await lapsed(club._id);
    const { insertedId } = await runningTournament(club._id);
    const token = tokenFor(club);

    expect(await can(token, "referee:assign")).toBe(true);

    // The event finishes.
    await Tournament.collection.updateOne(
      { _id: insertedId },
      { $set: { endDate: ymd(-1) } }
    );

    expect(await can(token, "referee:assign")).toBe(false);
  });
});

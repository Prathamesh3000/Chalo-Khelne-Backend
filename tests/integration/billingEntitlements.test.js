"use strict";
/**
 * Phase 2 checkpoint — the entitlement union inside requirePermission.
 *
 * THE test in this whole module is "Club A's purchase grants Club B nothing".
 * That is the bug the entire tenancy design exists to prevent, and the one
 * that would be invisible in manual testing: you would buy a plan as Club A,
 * see the feature unlock, and never notice Club B got it too.
 *
 * Everything runs through the REAL stack — a real JWT, the real `authenticate`
 * middleware (which establishes tenant context exactly as production does),
 * the real requirePermission gate, and the real Subscription model. Only the
 * route handler is a stub, so a failure here is a failure in the access path
 * rather than in tournament business logic.
 */
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { startTestApp, stopTestApp, clearDatabase, getApp } = require("./setup");
const { authenticate } = require("../../middleware/authMiddleware");
const { requirePermission, requireAnyPermission } = require("../../middleware/rbacMiddleware");

const User = require("../../src/modules/identity/models/User");
const Role = require("../../src/modules/identity/models/Role");
const Permission = require("../../src/modules/identity/models/Permission");
const Plan = require("../../src/modules/billing/models/Plan");
const Subscription = require("../../src/modules/billing/models/Subscription");

const PAID = "payment:read";      // sold by a plan, NOT in the base role
const FREE = "tournament:read";   // in the base role, never sold

let probe;

beforeAll(async () => {
  await startTestApp();

  // A minimal app carrying the real gates.
  probe = express();
  probe.get("/paid", authenticate, requirePermission(PAID), (_req, res) =>
    res.json({ ok: true })
  );
  probe.get("/free", authenticate, requirePermission(FREE), (_req, res) =>
    res.json({ ok: true })
  );
  probe.get("/either", authenticate, requireAnyPermission(PAID, "expense:read"), (_req, res) =>
    res.json({ ok: true })
  );
});
afterAll(stopTestApp);

beforeEach(async () => {
  await clearDatabase();
  await seedRoles();
});

/**
 * Base roles, deliberately minimal: club_admin and vendor hold FREE but NOT
 * PAID. Anything that answers 200 on /paid therefore did so because of a
 * subscription, which is precisely what these tests need to prove.
 */
async function seedRoles() {
  const keys = [FREE, PAID, "expense:read"];
  const ids = {};
  for (const key of keys) {
    const [module_, action] = key.split(":");
    const p = await Permission.create({ key, name: key, module: module_, action });
    ids[key] = p._id;
  }
  await Role.create({
    name: "Club Admin", slug: "club_admin", authorityLevel: 1, permissions: [ids[FREE]],
  });
  await Role.create({
    name: "Vendor", slug: "vendor", authorityLevel: 4, permissions: [ids[FREE]],
  });
  await Role.create({
    name: "Manager", slug: "manager", authorityLevel: 2, permissions: [ids[FREE]],
  });
}

let uniq = 0;
async function makeUser(role) {
  uniq += 1;
  return User.create({
    name: `${role}-${uniq}`,
    email: `billing-${uniq}-${Date.now()}@test.local`,
    password: "hashed-not-used",
    role,
    dateOfBirth: new Date("1990-01-01"),
    sex: "male",
    mobile: "9999999999",
  });
}

const tokenFor = (u) =>
  jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

const DAY = 24 * 60 * 60 * 1000;

async function subscribe(subjectId, over = {}) {
  return Subscription.create({
    subjectId,
    subjectType: "club",
    planSlug: "pro",
    grantedPermissions: [PAID],
    pricePaidRupees: 300,
    status: "active",
    startsAt: new Date(Date.now() - DAY),
    expiresAt: new Date(Date.now() + 30 * DAY),
    ...over,
  });
}

const getPaid = (token) =>
  request(probe).get("/paid").set("Authorization", `Bearer ${token}`);

// ═══════════════════════════════════════════════════════════════
// THE critical test
// ═══════════════════════════════════════════════════════════════

describe("cross-tenant isolation of a purchase", () => {
  test("Club A's purchase grants Club A access — and Club B NOTHING", async () => {
    const a = await makeUser("ClubAdmin");
    const b = await makeUser("ClubAdmin");
    const tokenA = tokenFor(a);
    const tokenB = tokenFor(b);

    // Before: neither can reach the paid route.
    expect((await getPaid(tokenA)).status).toBe(403);
    expect((await getPaid(tokenB)).status).toBe(403);

    // Club A buys.
    await subscribe(a._id);

    // A is in...
    expect((await getPaid(tokenA)).status).toBe(200);

    // ...and B is still out. If this ever returns 200, a purchase is leaking
    // across tenants and the product is being given away.
    expect((await getPaid(tokenB)).status).toBe(403);
  });

  test("a vendor's purchase is scoped to that vendor", async () => {
    const v1 = await makeUser("vendor");
    const v2 = await makeUser("vendor");

    await subscribe(v1._id, { subjectType: "vendor" });

    expect((await getPaid(tokenFor(v1))).status).toBe(200);
    expect((await getPaid(tokenFor(v2))).status).toBe(403);
  });

  test("a club's purchase does not leak to a vendor, or vice versa", async () => {
    const club = await makeUser("ClubAdmin");
    const vendor = await makeUser("vendor");

    await subscribe(club._id);

    expect((await getPaid(tokenFor(club))).status).toBe(200);
    expect((await getPaid(tokenFor(vendor))).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// Expiry — read-time, no job involved
// ═══════════════════════════════════════════════════════════════

describe("expiry", () => {
  test("a subscription that expired one second ago no longer grants", async () => {
    const a = await makeUser("ClubAdmin");
    await subscribe(a._id, { expiresAt: new Date(Date.now() - 1000) });

    // Nothing ran to revoke this. The row still says status:"active" — it is
    // the expiresAt comparison in the lookup that closes the door.
    expect((await getPaid(tokenFor(a))).status).toBe(403);
  });

  test("expiry falls back to the base role, never below it", async () => {
    const a = await makeUser("ClubAdmin");
    await subscribe(a._id, { expiresAt: new Date(Date.now() - 1000) });

    // The free feature the ROLE grants is untouched by the lapse.
    const res = await request(probe)
      .get("/free")
      .set("Authorization", `Bearer ${tokenFor(a)}`);
    expect(res.status).toBe(200);
  });

  test("a trialing subscription grants while live", async () => {
    const a = await makeUser("ClubAdmin");
    await subscribe(a._id, { status: "trialing", expiresAt: new Date(Date.now() + 7 * DAY) });
    expect((await getPaid(tokenFor(a))).status).toBe(200);
  });

  test("cancelled and expired rows never grant, even with a future expiresAt", async () => {
    const a = await makeUser("ClubAdmin");
    const sub = await subscribe(a._id, { status: "cancelled" });
    expect((await getPaid(tokenFor(a))).status).toBe(403);

    await Subscription.updateOne({ _id: sub._id }, { status: "expired" });
    expect((await getPaid(tokenFor(a))).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// Snapshot semantics
// ═══════════════════════════════════════════════════════════════

describe("grantedPermissions is a snapshot, not a live join", () => {
  test("editing the plan does not change what an existing subscriber holds", async () => {
    const a = await makeUser("ClubAdmin");
    const plan = await Plan.create({
      name: "Pro", slug: "pro", priceRupees: 300, durationDays: 30,
      audience: "club", permissionKeys: [PAID],
    });
    await subscribe(a._id, { planId: plan._id });

    expect((await getPaid(tokenFor(a))).status).toBe(200);

    // SuperAdmin strips the permission from the plan.
    await Plan.updateOne({ _id: plan._id }, { permissionKeys: [] });

    // The existing subscriber keeps what they paid for. Resolving through
    // planId instead of the snapshot would have revoked it mid-term.
    expect((await getPaid(tokenFor(a))).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// Staff inheritance
// ═══════════════════════════════════════════════════════════════

describe("manager inheritance", () => {
  test("a manager inherits the club's subscription, without holding one", async () => {
    const { Manager } = require("../../src/modules/identity/models/ClubManager");
    const club = await makeUser("ClubAdmin");
    const manager = await Manager.create({
      name: "Court Manager",
      email: `mgr-${Date.now()}@test.local`,
      password: "hashed-not-used",
      clubId: club._id,
      status: "active",
    });

    const mgrToken = jwt.sign(
      { id: String(manager._id), role: "Manager" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const app2 = express();
    const { managerAuth } = require("../../middleware/authMiddleware");
    app2.get("/paid", managerAuth, requirePermission(PAID), (_req, res) =>
      res.json({ ok: true })
    );

    // Before the club buys, the manager is out.
    let res = await request(app2).get("/paid").set("Authorization", `Bearer ${mgrToken}`);
    expect(res.status).toBe(403);

    // The CLUB buys — nothing is written against the manager at all.
    await subscribe(club._id);
    expect(await Subscription.countDocuments({ subjectId: manager._id })).toBe(0);

    // The manager is in, purely by inheriting the club's tenant id.
    res = await request(app2).get("/paid").set("Authorization", `Bearer ${mgrToken}`);
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// Gate parity + non-subjects
// ═══════════════════════════════════════════════════════════════

describe("both permission gates honour entitlements", () => {
  test("requireAnyPermission unlocks through a subscription too", async () => {
    const a = await makeUser("ClubAdmin");
    const token = tokenFor(a);

    let res = await request(probe).get("/either").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);

    await subscribe(a._id);

    res = await request(probe).get("/either").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("principals with no billing subject", () => {
  test("a player is unaffected — no subject, no entitlements, no crash", async () => {
    const p = await makeUser("Player");
    // No player role seeded, so this denies on the role, not on billing — the
    // point is that the entitlement lookup runs harmlessly for a null subject.
    const res = await getPaid(tokenFor(p));
    expect(res.status).toBe(403);
  });

  test("a player cannot borrow a club's subscription by id", async () => {
    const club = await makeUser("ClubAdmin");
    const player = await makeUser("Player");
    await subscribe(club._id);

    expect((await getPaid(tokenFor(player))).status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/billing/me — driven through the REAL app, so the route
// mount in routes/index.js is under test as well.
// ═══════════════════════════════════════════════════════════════

describe("GET /api/billing/me", () => {
  const me = (token) =>
    request(getApp()).get("/api/billing/me").set("Authorization", `Bearer ${token}`);

  test("requires authentication", async () => {
    const res = await request(getApp()).get("/api/billing/me");
    expect(res.status).toBe(401);
  });

  test("reports the base role and no subscription before buying", async () => {
    const a = await makeUser("ClubAdmin");
    const res = await me(tokenFor(a));

    expect(res.status).toBe(200);
    expect(res.body.subscription).toBeNull();
    expect(res.body.rolePermissions).toContain(FREE);
    expect(res.body.purchasedPermissions).toEqual([]);
    expect(res.body.effectivePermissions).toContain(FREE);
    expect(res.body.effectivePermissions).not.toContain(PAID);
  });

  test("reports the live subscription and the union after buying", async () => {
    const a = await makeUser("ClubAdmin");
    await subscribe(a._id);
    const res = await me(tokenFor(a));

    expect(res.status).toBe(200);
    expect(res.body.subscription.status).toBe("active");
    expect(res.body.subscription.planSlug).toBe("pro");
    expect(res.body.subscription.daysRemaining).toBeGreaterThan(28);
    expect(res.body.purchasedPermissions).toContain(PAID);

    // The union is what the server enforces, so it is what the UI must key off.
    expect(res.body.effectivePermissions).toEqual(
      expect.arrayContaining([FREE, PAID])
    );
  });

  test("an expired subscription reads as none — daysRemaining never goes negative", async () => {
    const a = await makeUser("ClubAdmin");
    await subscribe(a._id, { expiresAt: new Date(Date.now() - 5 * DAY) });
    const res = await me(tokenFor(a));

    expect(res.body.subscription).toBeNull();
    expect(res.body.effectivePermissions).not.toContain(PAID);
  });

  test("one club's endpoint never reports another club's subscription", async () => {
    const a = await makeUser("ClubAdmin");
    const b = await makeUser("ClubAdmin");
    await subscribe(a._id);

    const resB = await me(tokenFor(b));
    expect(resB.body.subscription).toBeNull();
    expect(resB.body.purchasedPermissions).toEqual([]);
  });
});

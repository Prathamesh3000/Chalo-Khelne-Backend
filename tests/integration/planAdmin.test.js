"use strict";
/**
 * Phase 4 checkpoint — the SuperAdmin plan control plane.
 *
 * Two properties matter most here and neither is obvious from reading the
 * controller:
 *
 *  1. The whole router is SuperAdmin-only. Pricing is the one surface where a
 *     misconfigured guard means a customer can grant themselves features.
 *  2. A plan cannot promise a permission that does not exist. A typo'd key
 *     would store fine and then never match at check time — the customer pays
 *     and the feature silently never unlocks, with nothing in the logs.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const {
  startTestApp, stopTestApp, clearDatabase, superAdminToken, getApp,
} = require("./setup");

const Superadminmodel = require("../../src/modules/identity/models/Superadminmodel");
const Permission = require("../../src/modules/identity/models/Permission");
const User = require("../../src/modules/identity/models/User");
const Plan = require("../../src/modules/billing/models/Plan");
const Subscription = require("../../src/modules/billing/models/Subscription");

const KEYS = ["payment:read", "expense:read", "report:view_all"];

let saToken;

beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);

beforeEach(async () => {
  await clearDatabase();

  // requireSuperAdmin resolves membership from the Superadmin collection, so a
  // real row must exist — a role claim alone is not enough (by design).
  const sa = await Superadminmodel.create({
    email: "sa@test.local",
    password: "hashed-not-used",
  });
  saToken = jwt.sign(
    { userId: String(sa._id), email: sa.email, role: "superadmin" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  for (const key of KEYS) {
    const [module_, action] = key.split(":");
    await Permission.create({ key, name: key, module: module_, action });
  }
});

const api = () => request(getApp());
const asSA = (req) => req.set("Authorization", `Bearer ${saToken}`);

const body = (over = {}) => ({
  name: "Pro",
  slug: "pro",
  priceRupees: 300,
  durationDays: 30,
  audience: "club",
  permissionKeys: ["payment:read", "expense:read"],
  ...over,
});

// ═══════════════════════════════════════════════════════════════
// Access control
// ═══════════════════════════════════════════════════════════════

describe("the plan router is SuperAdmin-only", () => {
  test("rejects an unauthenticated caller", async () => {
    expect((await api().get("/api/plans")).status).toBe(401);
  });

  test("rejects a club admin — a customer must not edit pricing", async () => {
    const club = await User.create({
      name: "Club", email: `club-${Date.now()}@test.local`, password: "x",
      role: "ClubAdmin", dateOfBirth: new Date("1990-01-01"), sex: "male", mobile: "9999999999",
    });
    const token = jwt.sign(
      { id: String(club._id), role: "ClubAdmin" },
      process.env.JWT_SECRET, { expiresIn: "1h" }
    );

    const res = await api().get("/api/plans").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test("every write verb is guarded, not just the reads", async () => {
    const plan = await Plan.create(body());
    const noAuth = [
      api().post("/api/plans").send(body({ slug: "x" })),
      api().put(`/api/plans/${plan._id}`).send({ priceRupees: 1 }),
      api().delete(`/api/plans/${plan._id}`),
    ];
    for (const res of await Promise.all(noAuth)) {
      expect(res.status).toBe(401);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Create
// ═══════════════════════════════════════════════════════════════

describe("POST /api/plans", () => {
  test("creates a plan from ticked permission keys", async () => {
    const res = await asSA(api().post("/api/plans")).send(body());
    expect(res.status).toBe(201);
    expect(res.body.plan.slug).toBe("pro");
    expect(res.body.plan.permissionKeys).toEqual(["payment:read", "expense:read"]);
  });

  test("REJECTS a permission key that is not in the catalogue", async () => {
    // The silent-failure guard: "payment:raed" would store happily and then
    // never match anything at check time.
    const res = await asSA(api().post("/api/plans")).send(
      body({ permissionKeys: ["payment:read", "payment:raed"] })
    );
    expect(res.status).toBe(400);
    expect(res.body.unknownKeys).toEqual(["payment:raed"]);
    expect(await Plan.countDocuments({})).toBe(0);
  });

  test("rejects a duplicate slug", async () => {
    await asSA(api().post("/api/plans")).send(body());
    const res = await asSA(api().post("/api/plans")).send(body({ name: "Pro 2" }));
    expect(res.status).toBe(409);
  });

  test("requires the money fields", async () => {
    const res = await asSA(api().post("/api/plans")).send({
      name: "Broken", slug: "broken", audience: "club",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/priceRupees/);
  });

  test("a schema violation answers 400, not 500 — it is the payload that is wrong", async () => {
    const res = await asSA(api().post("/api/plans")).send(
      body({ slug: "frac", priceRupees: 299.5 })
    );
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// Update — the snapshot guarantee
// ═══════════════════════════════════════════════════════════════

describe("PUT /api/plans/:id", () => {
  test("updates fields and re-validates permission keys", async () => {
    const plan = await Plan.create(body());
    const ok = await asSA(api().put(`/api/plans/${plan._id}`)).send({
      priceRupees: 400, permissionKeys: ["report:view_all"],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.plan.priceRupees).toBe(400);

    const bad = await asSA(api().put(`/api/plans/${plan._id}`)).send({
      permissionKeys: ["nope:nope"],
    });
    expect(bad.status).toBe(400);
  });

  test("reports how many live subscribers are unaffected by the edit", async () => {
    const plan = await Plan.create(body());
    await Subscription.create({
      subjectId: new mongoose.Types.ObjectId(), subjectType: "club",
      planId: plan._id, planSlug: "pro", grantedPermissions: ["payment:read"],
      status: "active", startsAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 864e5),
    });

    const res = await asSA(api().put(`/api/plans/${plan._id}`)).send({
      permissionKeys: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.activeSubscribers).toBe(1);
    // The operator is told plainly that stripping the plan did not strip
    // anyone's access — otherwise they would assume it had.
    expect(res.body.note).toMatch(/keep the permissions they bought/i);
  });

  test("slug is immutable — Subscription history denormalises it", async () => {
    const plan = await Plan.create(body());
    await asSA(api().put(`/api/plans/${plan._id}`)).send({ slug: "renamed" });
    const after = await Plan.findById(plan._id);
    expect(after.slug).toBe("pro");
  });
});

// ═══════════════════════════════════════════════════════════════
// Delete — refuses to orphan subscribers
// ═══════════════════════════════════════════════════════════════

describe("DELETE /api/plans/:id", () => {
  test("deletes a plan nobody has bought", async () => {
    const plan = await Plan.create(body());
    const res = await asSA(api().delete(`/api/plans/${plan._id}`));
    expect(res.status).toBe(200);
    expect(await Plan.countDocuments({})).toBe(0);
  });

  test("REFUSES while subscriptions reference it, and says what to do instead", async () => {
    const plan = await Plan.create(body());
    await Subscription.create({
      subjectId: new mongoose.Types.ObjectId(), subjectType: "club",
      planId: plan._id, planSlug: "pro", grantedPermissions: [],
      status: "active", startsAt: new Date(),
      expiresAt: new Date(Date.now() + 864e5),
    });

    const res = await asSA(api().delete(`/api/plans/${plan._id}`));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/isActive:false/);
    expect(await Plan.countDocuments({})).toBe(1);
  });

  test("an expired subscriber still blocks deletion — history is preserved", async () => {
    const plan = await Plan.create(body());
    await Subscription.create({
      subjectId: new mongoose.Types.ObjectId(), subjectType: "club",
      planId: plan._id, planSlug: "pro", grantedPermissions: [],
      status: "expired", startsAt: new Date("2020-01-01"),
      expiresAt: new Date("2020-02-01"),
    });
    expect((await asSA(api().delete(`/api/plans/${plan._id}`))).status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════
// List
// ═══════════════════════════════════════════════════════════════

describe("GET /api/plans", () => {
  test("returns every plan including retired ones, with subscriber counts", async () => {
    const live = await Plan.create(body());
    await Plan.create(body({ slug: "retired", name: "Retired", isActive: false }));
    await Subscription.create({
      subjectId: new mongoose.Types.ObjectId(), subjectType: "club",
      planId: live._id, planSlug: "pro", grantedPermissions: [],
      status: "active", startsAt: new Date(),
      expiresAt: new Date(Date.now() + 864e5),
    });

    const res = await asSA(api().get("/api/plans"));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);

    const pro = res.body.plans.find((p) => p.slug === "pro");
    expect(pro.activeSubscribers).toBe(1);
    const retired = res.body.plans.find((p) => p.slug === "retired");
    expect(retired.activeSubscribers).toBe(0);
  });

  test("filters by audience", async () => {
    await Plan.create(body());
    await Plan.create(body({ slug: "vpro", audience: "vendor" }));

    const res = await asSA(api().get("/api/plans?audience=vendor"));
    expect(res.body.total).toBe(1);
    expect(res.body.plans[0].slug).toBe("vpro");
  });

  test("an expired subscription is not counted as an active subscriber", async () => {
    const plan = await Plan.create(body());
    await Subscription.create({
      subjectId: new mongoose.Types.ObjectId(), subjectType: "club",
      planId: plan._id, planSlug: "pro", grantedPermissions: [],
      status: "active", startsAt: new Date("2020-01-01"),
      expiresAt: new Date("2020-02-01"), // past
    });

    const res = await asSA(api().get("/api/plans"));
    expect(res.body.plans[0].activeSubscribers).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// scripts/seedPlans — idempotency and catalogue safety
// ═══════════════════════════════════════════════════════════════

describe("seedPlans", () => {
  const seedPlans = require("../../scripts/seedPlans");

  test("creates the starter plans, dropping keys absent from the catalogue", async () => {
    // Only the 3 KEYS permissions exist in this suite, so the draft plans'
    // other keys must be dropped rather than stored as dead promises.
    const results = await seedPlans();
    expect(results.every((r) => r.action === "created")).toBe(true);

    const pro = await Plan.findOne({ slug: "pro" });
    expect(pro).toBeTruthy();
    for (const key of pro.permissionKeys) {
      expect(KEYS).toContain(key);
    }
  });

  test("is idempotent — a second run creates no duplicates", async () => {
    await seedPlans();
    const results = await seedPlans();

    expect(results.every((r) => r.action.startsWith("skipped"))).toBe(true);
    expect(await Plan.countDocuments({ slug: "pro" })).toBe(1);
  });

  test("does NOT overwrite operator edits without --force", async () => {
    await seedPlans();
    await Plan.updateOne({ slug: "pro" }, { priceRupees: 499 });

    await seedPlans();
    const pro = await Plan.findOne({ slug: "pro" });
    // A seed run must never silently undo real pricing work.
    expect(pro.priceRupees).toBe(499);
  });

  test("--force does overwrite, deliberately", async () => {
    await seedPlans();
    await Plan.updateOne({ slug: "pro" }, { priceRupees: 499 });

    await seedPlans({ force: true });
    const pro = await Plan.findOne({ slug: "pro" });
    expect(pro.priceRupees).toBe(300);
  });

  test("the trial is not publicly listed — it is granted, not bought", async () => {
    await seedPlans();
    const trial = await Plan.findOne({ slug: "trial" });
    expect(trial.isPublic).toBe(false);
    expect(trial.durationDays).toBe(7);
    expect(trial.trialDays).toBe(7);
  });
});

"use strict";
/**
 * Phase 1 checkpoint — the Plan and Subscription schemas.
 *
 * Three things are being pinned down here:
 *
 *  1. strict:"throw" really throws. These are money schemas; a typo'd field
 *     must be a loud failure, not a silent drop (the §2.6 rule).
 *  2. The money and duration fields reject the values that would corrupt
 *     billing — floats, negatives, zero-length plans.
 *  3. Subscription is NOT tenant-scoped, and that is deliberate. See the long
 *     comment in the model: tenantScope skips filtering for any principal
 *     without a clubId, which is exactly what a vendor is, so relying on it
 *     would let a vendor read every club's subscription.
 */
const mongoose = require("mongoose");
const { startTestApp, stopTestApp, clearDatabase } = require("./setup");
const { runWithTenant, contextForUser } = require("../../utils/tenantContext");

const Plan = require("../../src/modules/billing/models/Plan");
const Subscription = require("../../src/modules/billing/models/Subscription");

const clubA = new mongoose.Types.ObjectId();
const clubB = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);
beforeEach(clearDatabase);

const validPlan = (over = {}) => ({
  name: "Pro",
  slug: "pro",
  priceRupees: 300,
  durationDays: 30,
  audience: "club",
  permissionKeys: ["payment:read", "expense:read"],
  ...over,
});

const validSub = (over = {}) => ({
  subjectId: clubA,
  subjectType: "club",
  planSlug: "pro",
  grantedPermissions: ["payment:read"],
  pricePaidRupees: 300,
  status: "active",
  startsAt: new Date("2026-08-01"),
  expiresAt: new Date("2026-09-01"),
  ...over,
});

// ═══════════════════════════════════════════════════════════════
// Plan
// ═══════════════════════════════════════════════════════════════

describe("Plan schema", () => {
  test("accepts a well-formed plan", async () => {
    const p = await Plan.create(validPlan());
    expect(p.slug).toBe("pro");
    expect(p.isActive).toBe(true);
    expect(p.isPublic).toBe(true);
    expect(p.trialDays).toBe(0);
  });

  test("strict:throw rejects an unknown field", async () => {
    // The failure mode this guards: someone writes `price` instead of
    // `priceRupees`, mongoose drops it silently, and every plan costs 0.
    await expect(
      Plan.create(validPlan({ price: 300 }))
    ).rejects.toThrow(/price/i);
  });

  test("rejects a fractional price — rupees are integers", async () => {
    await expect(
      Plan.create(validPlan({ priceRupees: 299.99 }))
    ).rejects.toThrow(/whole number/i);
  });

  test("rejects a negative price", async () => {
    await expect(
      Plan.create(validPlan({ priceRupees: -1 }))
    ).rejects.toThrow(/negative/i);
  });

  test("allows a zero price — that is the free tier", async () => {
    const p = await Plan.create(validPlan({ slug: "free", priceRupees: 0 }));
    expect(p.priceRupees).toBe(0);
  });

  test("rejects a zero-day duration", async () => {
    await expect(
      Plan.create(validPlan({ durationDays: 0 }))
    ).rejects.toThrow(/at least one day/i);
  });

  test("rejects an audience outside club|vendor", async () => {
    await expect(
      Plan.create(validPlan({ audience: "player" }))
    ).rejects.toThrow();
  });

  test("rejects a slug with illegal characters", async () => {
    await expect(
      Plan.create(validPlan({ slug: "Pro Plan!" }))
    ).rejects.toThrow(/slug/i);
  });

  test("slug is unique", async () => {
    await Plan.syncIndexes(); // setup.js disables autoIndex
    await Plan.create(validPlan());
    await expect(Plan.create(validPlan({ name: "Pro Copy" }))).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// Subscription
// ═══════════════════════════════════════════════════════════════

describe("Subscription schema", () => {
  test("accepts a well-formed subscription", async () => {
    const s = await Subscription.create(validSub());
    expect(String(s.subjectId)).toBe(String(clubA));
    expect(s.isComped).toBe(false);
    expect(s.grantedPermissions).toEqual(["payment:read"]);
  });

  test("strict:throw rejects an unknown field", async () => {
    // Specifically guards against writing `clubId` here out of habit — this
    // model uses subjectId, because a vendor's subject is not a club.
    await expect(
      Subscription.create(validSub({ clubId: clubA }))
    ).rejects.toThrow(/clubId/i);
  });

  test("requires subjectId, status, startsAt and expiresAt", async () => {
    await expect(Subscription.create({ subjectType: "club" })).rejects.toThrow();
  });

  test("rejects a status outside the lifecycle enum", async () => {
    await expect(
      Subscription.create(validSub({ status: "paused" }))
    ).rejects.toThrow();
  });

  test("razorpayOrderId is unique — an order can activate only one row", async () => {
    await Subscription.syncIndexes();
    await Subscription.create(validSub({ razorpayOrderId: "order_ABC123" }));
    await expect(
      Subscription.create(validSub({ subjectId: clubB, razorpayOrderId: "order_ABC123" }))
    ).rejects.toThrow();
  });

  test("the unique index is PARTIAL — many trial/comped rows carry no order id", async () => {
    // Regression guard for a real bug caught here: the index was first written
    // `sparse: true`, but razorpayOrderId defaults to null, so the field is
    // always PRESENT and sparse skipped nothing. The second trial subscription
    // ever created died with E11000 on { razorpayOrderId: null } — i.e. every
    // club after the very first would have got no trial.
    await Subscription.syncIndexes();
    await Subscription.create(validSub({ subjectId: clubA, status: "trialing" }));
    await Subscription.create(validSub({ subjectId: clubB, status: "trialing" }));
    expect(await Subscription.countDocuments({})).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// The deliberate absence of tenantScope
// ═══════════════════════════════════════════════════════════════

describe("Subscription is intentionally NOT tenant-scoped", () => {
  beforeEach(async () => {
    await Subscription.collection.insertMany([
      { subjectId: clubA, subjectType: "club", status: "active", startsAt: new Date(), expiresAt: new Date("2030-01-01"), grantedPermissions: [] },
      { subjectId: clubB, subjectType: "club", status: "active", startsAt: new Date(), expiresAt: new Date("2030-01-01"), grantedPermissions: [] },
    ]);
  });

  test("the schema has no clubId path — nothing for the plugin to hook", () => {
    expect(Subscription.schema.path("clubId")).toBeUndefined();
    expect(Subscription.schema.path("subjectId")).toBeDefined();
  });

  test("an unfiltered query is NOT auto-scoped — isolation must be explicit", async () => {
    // Documents the contract that makes utils/entitlements.js load-bearing:
    // this model does not protect itself, so every caller MUST pass subjectId.
    const all = await runWithTenant(contextForUser("ClubAdmin", clubA), () =>
      Subscription.find({}).lean()
    );
    expect(all).toHaveLength(2);
  });

  test("an explicit subjectId filter isolates correctly", async () => {
    const mine = await Subscription.find({ subjectId: clubA }).lean();
    expect(mine).toHaveLength(1);
    expect(String(mine[0].subjectId)).toBe(String(clubA));
  });
});

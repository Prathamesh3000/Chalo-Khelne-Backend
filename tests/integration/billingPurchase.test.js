"use strict";
/**
 * Phase 5 checkpoint — buying a plan.
 *
 * Two traps live here and both have bitten this codebase's ancestors:
 *
 *  Trap 4 — the price must come from the Plan document, server-side. This is
 *           §2.4 of DEFECT_REMEDIATION_TRACKER.md repeating: tournament fees
 *           were once taken from the request body, and a ₹300 plan bought for
 *           ₹1 is the same bug wearing a different hat.
 *
 *  Trap 9 — activation must be idempotent. Razorpay retries webhooks, and
 *           /verify fires for the same payment, so a naive implementation
 *           grants two or three months for one payment.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// The gateway is mocked: these tests are about OUR logic, not Razorpay's.
// utils/razorpay reads its keys at module load, so env vars set here would be
// too late — mocking the module is the honest way to exercise the path.
jest.mock("../../utils/razorpay", () => ({
  isConfigured: () => true,
  publicKeyId: () => "rzp_test_FAKE",
  createOrder: jest.fn(async ({ amountPaise, receipt }) => ({
    id: `order_${receipt}`,
    amount: amountPaise,
    currency: "INR",
  })),
  verifySignature: () => true,
  verifyWebhook: () => true,
}));

const { startTestApp, stopTestApp, clearDatabase, getApp } = require("./setup");
const rp = require("../../utils/razorpay");
const { activateFromPayment, grantTrial } = require("../../services/subscriptionService");

const User = require("../../src/modules/identity/models/User");
const Plan = require("../../src/modules/billing/models/Plan");
const Subscription = require("../../src/modules/billing/models/Subscription");
const RazorpayPayment = require("../../src/modules/commerce/models/RazorpayPayment");

const DAY = 24 * 60 * 60 * 1000;
let uniq = 0;

beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);

beforeEach(async () => {
  await clearDatabase();
  rp.createOrder.mockClear();
});

async function makeUser(role) {
  uniq += 1;
  return User.create({
    name: `${role}-${uniq}`,
    email: `buy-${uniq}-${Date.now()}@test.local`,
    password: "x",
    role,
    dateOfBirth: new Date("1990-01-01"),
    sex: "male",
    mobile: "9999999999",
  });
}

const tokenFor = (u) =>
  jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

const makePlan = (over = {}) =>
  Plan.create({
    name: "Pro", slug: `pro_${++uniq}`, priceRupees: 300, durationDays: 30,
    audience: "club", permissionKeys: ["payment:read"], ...over,
  });

const subscribe = (token, body) =>
  request(getApp()).post("/api/billing/subscribe")
    .set("Authorization", `Bearer ${token}`).send(body);

// ═══════════════════════════════════════════════════════════════
// TRAP 4 — the price is not negotiable by the client
// ═══════════════════════════════════════════════════════════════

describe("the order amount comes from the Plan, never the request", () => {
  test("a tampered amount in the body is ignored entirely", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan({ priceRupees: 300 });

    const res = await subscribe(tokenFor(club), {
      planId: String(plan._id),
      // Every shape an attacker might try.
      amountRupees: 1,
      amountPaise: 100,
      priceRupees: 1,
      amount: 1,
    });

    expect(res.status).toBe(201);
    expect(res.body.amountPaise).toBe(30000); // ₹300, from the Plan
    expect(res.body.amountRupees).toBe(300);

    // And the gateway was asked for the real amount, not the claimed one.
    expect(rp.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 30000 })
    );

    // The stored payment record agrees.
    const payment = await RazorpayPayment.findOne({});
    expect(payment.amountPaise).toBe(30000);
  });

  test("the payment record carries the billing subject for the webhook to use", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan();
    await subscribe(tokenFor(club), { planId: String(plan._id) });

    const payment = await RazorpayPayment.findOne({});
    expect(payment.purpose).toBe("subscription");
    expect(String(payment.refId)).toBe(String(plan._id));
    // Without this the webhook — which has no auth context — cannot know who
    // to activate.
    expect(payment.notes.subjectId).toBe(String(club._id));
    expect(payment.notes.subjectType).toBe("club");
  });
});

// ═══════════════════════════════════════════════════════════════
// Who may buy what
// ═══════════════════════════════════════════════════════════════

describe("purchase eligibility", () => {
  test("a club cannot buy a vendor plan by passing its id", async () => {
    const club = await makeUser("ClubAdmin");
    const vendorPlan = await makePlan({ audience: "vendor" });

    const res = await subscribe(tokenFor(club), { planId: String(vendorPlan._id) });
    expect(res.status).toBe(403);
    expect(await RazorpayPayment.countDocuments({})).toBe(0);
  });

  test("a retired plan cannot be bought", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan({ isActive: false });

    const res = await subscribe(tokenFor(club), { planId: String(plan._id) });
    expect(res.status).toBe(409);
  });

  test("a free plan cannot be bought — free access is granted, not purchased", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan({ priceRupees: 0 });

    const res = await subscribe(tokenFor(club), { planId: String(plan._id) });
    expect(res.status).toBe(400);
  });

  test("a player has no billing subject and cannot subscribe", async () => {
    const player = await makeUser("Player");
    const plan = await makePlan();

    const res = await subscribe(tokenFor(player), { planId: String(plan._id) });
    expect(res.status).toBe(403);
  });

  test("planId is required", async () => {
    const club = await makeUser("ClubAdmin");
    expect((await subscribe(tokenFor(club), {})).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// TRAP 9 — activation is idempotent
// ═══════════════════════════════════════════════════════════════

describe("activation idempotency", () => {
  const activate = (subjectId, planId, orderId) =>
    activateFromPayment({
      subjectId, subjectType: "club", planId,
      razorpayOrderId: orderId, pricePaidRupees: 300,
    });

  test("the same order activated twice grants ONE period", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan();

    const first = await activate(club._id, plan._id, "order_SAME");
    const second = await activate(club._id, plan._id, "order_SAME");

    expect(String(first._id)).toBe(String(second._id));
    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
    expect(await Subscription.countDocuments({ subjectId: club._id })).toBe(1);
  });

  test("verify and webhook firing for one payment grant ONE period", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan();
    const { applyPaymentToPurpose } = require("../../controllers/razorpayController");

    const payment = await RazorpayPayment.create({
      userId: club._id, purpose: "subscription", refId: plan._id,
      amountPaise: 30000, razorpayOrderId: "order_BOTH", status: "paid",
      notes: { subjectId: String(club._id), subjectType: "club" },
    });

    await applyPaymentToPurpose(payment); // /verify
    const afterVerify = await Subscription.findOne({ subjectId: club._id });

    await applyPaymentToPurpose(payment); // webhook retry
    const all = await Subscription.find({ subjectId: club._id });

    expect(all).toHaveLength(1);
    expect(all[0].expiresAt.getTime()).toBe(afterVerify.expiresAt.getTime());
  });

  test("two concurrent activations of one order still grant ONE period", async () => {
    await Subscription.syncIndexes(); // the unique index is what breaks the tie
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan();

    const results = await Promise.all([
      activate(club._id, plan._id, "order_RACE"),
      activate(club._id, plan._id, "order_RACE"),
    ]);

    expect(await Subscription.countDocuments({ subjectId: club._id })).toBe(1);
    expect(String(results[0]._id)).toBe(String(results[1]._id));
  });
});

// ═══════════════════════════════════════════════════════════════
// Renewal
// ═══════════════════════════════════════════════════════════════

describe("renewal", () => {
  test("renewing early stacks — no days are lost", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan({ durationDays: 30 });

    const first = await activateFromPayment({
      subjectId: club._id, subjectType: "club", planId: plan._id,
      razorpayOrderId: "order_1",
    });

    // Renew with 30 days still on the clock.
    const second = await activateFromPayment({
      subjectId: club._id, subjectType: "club", planId: plan._id,
      razorpayOrderId: "order_2",
    });

    // The new period begins where the old one ended, not today.
    expect(second.startsAt.getTime()).toBe(first.expiresAt.getTime());
    const gap = second.expiresAt.getTime() - first.expiresAt.getTime();
    expect(Math.round(gap / DAY)).toBe(30);
  });

  test("exactly one subscription stays live after a renewal", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan();

    await activateFromPayment({ subjectId: club._id, subjectType: "club", planId: plan._id, razorpayOrderId: "o1" });
    await activateFromPayment({ subjectId: club._id, subjectType: "club", planId: plan._id, razorpayOrderId: "o2" });

    const live = await Subscription.countDocuments({
      subjectId: club._id,
      status: { $in: ["trialing", "active"] },
      expiresAt: { $gt: new Date() },
    });
    expect(live).toBe(1);
    // The superseded row is kept as history, not deleted.
    expect(await Subscription.countDocuments({ subjectId: club._id })).toBe(2);
  });

  test("activation snapshots the plan's permissions", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan({ permissionKeys: ["payment:read", "expense:read"] });

    const sub = await activateFromPayment({
      subjectId: club._id, subjectType: "club", planId: plan._id, razorpayOrderId: "o_snap",
    });
    expect(sub.grantedPermissions).toEqual(["payment:read", "expense:read"]);

    // Later plan edits do not reach into the snapshot.
    await Plan.updateOne({ _id: plan._id }, { permissionKeys: [] });
    const reread = await Subscription.findById(sub._id);
    expect(reread.grantedPermissions).toEqual(["payment:read", "expense:read"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// TRAP 10 — one trial per subject
// ═══════════════════════════════════════════════════════════════

describe("trials", () => {
  test("a trial is granted once and refused thereafter", async () => {
    const club = await makeUser("ClubAdmin");
    await Plan.create({
      name: "Trial", slug: "trial", priceRupees: 0, durationDays: 7,
      trialDays: 7, audience: "club", permissionKeys: ["payment:read"], isPublic: false,
    });

    const first = await grantTrial({ subjectId: club._id, subjectType: "club" });
    expect(first.granted).toBe(true);
    expect(first.subscription.status).toBe("trialing");
    expect(Math.round((first.subscription.expiresAt - first.subscription.startsAt) / DAY)).toBe(7);

    const second = await grantTrial({ subjectId: club._id, subjectType: "club" });
    expect(second.granted).toBe(false);
  });

  test("an EXPIRED trial still blocks a second one", async () => {
    const club = await makeUser("ClubAdmin");
    await Plan.create({
      name: "Trial", slug: "trial", priceRupees: 0, durationDays: 7,
      trialDays: 7, audience: "club", permissionKeys: [], isPublic: false,
    });

    const first = await grantTrial({ subjectId: club._id, subjectType: "club" });
    await Subscription.updateOne(
      { _id: first.subscription._id },
      { status: "expired", expiresAt: new Date(Date.now() - DAY) }
    );

    // The record of having trialled outlives the trial itself — otherwise a
    // club just waits a week and trials again forever.
    const second = await grantTrial({ subjectId: club._id, subjectType: "club" });
    expect(second.granted).toBe(false);
  });

  test("a missing trial plan is reported, not thrown", async () => {
    const club = await makeUser("ClubAdmin");
    const res = await grantTrial({ subjectId: club._id, subjectType: "club" });
    expect(res.granted).toBe(false);
    expect(res.reason).toMatch(/no "trial" plan/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// GET /api/billing/plans
// ═══════════════════════════════════════════════════════════════

describe("GET /api/billing/plans", () => {
  const plans = (token) =>
    request(getApp()).get("/api/billing/plans").set("Authorization", `Bearer ${token}`);

  test("a club sees club plans only — audience is derived, not requested", async () => {
    const club = await makeUser("ClubAdmin");
    await makePlan({ audience: "club", name: "Club Pro" });
    await makePlan({ audience: "vendor", name: "Vendor Pro" });

    const res = await plans(tokenFor(club));
    expect(res.status).toBe(200);
    expect(res.body.audience).toBe("club");
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].name).toBe("Club Pro");
  });

  test("retired and unlisted plans are hidden from customers", async () => {
    const club = await makeUser("ClubAdmin");
    await makePlan({ name: "Live" });
    await makePlan({ name: "Retired", isActive: false });
    await makePlan({ name: "Hidden", isPublic: false });

    const res = await plans(tokenFor(club));
    expect(res.body.plans.map((p) => p.name)).toEqual(["Live"]);
  });

  test("the caller's current plan is reported alongside the list", async () => {
    const club = await makeUser("ClubAdmin");
    const plan = await makePlan();
    await activateFromPayment({
      subjectId: club._id, subjectType: "club", planId: plan._id, razorpayOrderId: "o_cur",
    });

    const res = await plans(tokenFor(club));
    expect(res.body.currentPlanSlug).toBe(plan.slug);
  });
});

// ═══════════════════════════════════════════════════════════════
// Phase 6 — the trial is granted at account creation
// ═══════════════════════════════════════════════════════════════

describe("trial on signup", () => {
  const seedTrialPlan = () =>
    Plan.create({
      name: "Trial", slug: "trial", priceRupees: 0, durationDays: 7,
      trialDays: 7, audience: "club", permissionKeys: ["payment:read"], isPublic: false,
    });

  test("registering as a ClubAdmin grants a 7-day trial", async () => {
    await seedTrialPlan();

    const res = await request(getApp()).post("/api/register").send({
      name: "New Club", email: `newclub-${Date.now()}@test.local`,
      password: "Password@123", mobile: "9998887777", role: "ClubAdmin",
      clubName: `Club ${Date.now()}`, dateOfBirth: "1990-01-01", sex: "male",
    });
    expect([200, 201]).toContain(res.status);

    const user = await User.findOne({ role: "ClubAdmin" }).sort({ createdAt: -1 });
    const sub = await Subscription.findOne({ subjectId: user._id });

    expect(sub).toBeTruthy();
    expect(sub.status).toBe("trialing");
    expect(sub.subjectType).toBe("club");
    expect(Math.round((sub.expiresAt - sub.startsAt) / DAY)).toBe(7);
  });

  test("registration still succeeds when NO trial plan is configured", async () => {
    // The account is the valuable thing. A missing plan must degrade to "no
    // trial", never to "signup failed".
    const res = await request(getApp()).post("/api/register").send({
      name: "No Trial Club", email: `notrial-${Date.now()}@test.local`,
      password: "Password@123", mobile: "9998887776", role: "ClubAdmin",
      clubName: `NoTrial ${Date.now()}`, dateOfBirth: "1990-01-01", sex: "male",
    });

    expect([200, 201]).toContain(res.status);
    expect(await Subscription.countDocuments({})).toBe(0);
  });

  test("a registering PLAYER gets no trial — players are not billing subjects", async () => {
    await seedTrialPlan();

    await request(getApp()).post("/api/register").send({
      name: "A Player", email: `player-${Date.now()}@test.local`,
      password: "Password@123", mobile: "9998887775", role: "Player",
      dateOfBirth: "1990-01-01", sex: "male",
    });

    expect(await Subscription.countDocuments({})).toBe(0);
  });

  test("the trial grants the plan's permissions immediately", async () => {
    await seedTrialPlan();

    await request(getApp()).post("/api/register").send({
      name: "Trial Club", email: `trialclub-${Date.now()}@test.local`,
      password: "Password@123", mobile: "9998887774", role: "ClubAdmin",
      clubName: `TrialClub ${Date.now()}`, dateOfBirth: "1990-01-01", sex: "male",
    });

    const user = await User.findOne({ role: "ClubAdmin" }).sort({ createdAt: -1 });
    const { grantedPermissions } = await Subscription.findOne({ subjectId: user._id });
    expect(grantedPermissions).toContain("payment:read");
  });
});

"use strict";
/**
 * Subscription lifecycle — activation, renewal and trials.
 *
 * Called from three places that must all behave identically:
 *   • razorpayController.verify   (the client posts back a signed callback)
 *   • razorpayController.webhook  (Razorpay calls us, server-to-server)
 *   • the trial grant on club creation
 *
 * The first two fire for the SAME payment routinely — Razorpay retries
 * webhooks, and /verify may already have run. Activation is therefore
 * idempotent, keyed on the gateway order id.
 */
const Plan = require("../src/modules/billing/models/Plan");
const RazorpayPayment = require("../src/modules/commerce/models/RazorpayPayment");
const rp = require("../utils/razorpay");
const Subscription = require("../src/modules/billing/models/Subscription");
const { LIVE_STATUSES } = require("../utils/entitlements");

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subject's live subscription, if any. */
function findLive(subjectId) {
  return Subscription.findOne({
    subjectId,
    status: { $in: LIVE_STATUSES },
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 });
}

/**
 * Turn a paid order into access.
 *
 * Idempotent: a second call with the same razorpayOrderId returns the existing
 * subscription untouched rather than granting another period. Both the
 * pre-check and the unique partial index enforce this — the index is what
 * catches two webhook deliveries racing each other, where both would otherwise
 * pass the pre-check.
 *
 * Renewal stacks: if the subject still has time left, the new period starts
 * when the old one ends, so nobody loses days by renewing early. The old row is
 * superseded so exactly one live subscription remains.
 *
 * @param {object} args
 * @param {string} args.subjectId    recorded at order time, NOT resolved here
 * @param {string} args.subjectType  "club" | "vendor"
 * @param {string} args.planId
 * @param {string} [args.razorpayOrderId]
 * @param {string} [args.razorpayPaymentId]
 * @param {number} [args.pricePaidRupees]
 */
async function activateFromPayment({
  subjectId,
  subjectType,
  planId,
  razorpayOrderId = null,
  razorpayPaymentId = null,
  pricePaidRupees,
}) {
  if (!subjectId || !planId) {
    throw new Error("activateFromPayment requires subjectId and planId");
  }

  // Already activated for this order? Nothing to do.
  if (razorpayOrderId) {
    const already = await Subscription.findOne({ razorpayOrderId });
    if (already) return already;
  }

  const plan = await Plan.findById(planId).lean();
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const now = new Date();
  const live = await findLive(subjectId);

  // Start when the current period ends, so renewing early costs nothing.
  const startsAt = live && live.expiresAt > now ? live.expiresAt : now;
  const expiresAt = new Date(startsAt.getTime() + plan.durationDays * DAY_MS);

  let created;
  try {
    created = await Subscription.create({
      subjectId,
      subjectType,
      planId: plan._id,
      planSlug: plan.slug,
      // SNAPSHOT — a later plan edit must not change what was bought.
      grantedPermissions: [...(plan.permissionKeys || [])],
      pricePaidRupees:
        pricePaidRupees !== undefined ? pricePaidRupees : plan.priceRupees,
      status: "active",
      startsAt,
      expiresAt,
      razorpayOrderId,
      razorpayPaymentId,
    });
  } catch (err) {
    // Two deliveries raced past the pre-check; the unique index caught the
    // loser. Return whichever row won — the customer got exactly one period.
    if (err && err.code === 11000 && razorpayOrderId) {
      const winner = await Subscription.findOne({ razorpayOrderId });
      if (winner) return winner;
    }
    throw err;
  }

  // Supersede the old row only AFTER the new one exists, so a failure above
  // can never leave the subject with no subscription at all.
  if (live && String(live._id) !== String(created._id)) {
    await Subscription.updateOne({ _id: live._id }, { status: "expired" });
  }

  return created;
}

/**
 * Grant a trial. Same machinery as a purchase — there is no separate trial
 * code path, so a trial cannot drift from paid behaviour.
 *
 * Refuses if the subject has ever held a subscription, which is what stops a
 * club claiming a fresh trial every week from a new address (Trap 10).
 */
async function grantTrial({ subjectId, subjectType, planSlug = "trial" }) {
  if (!subjectId) throw new Error("grantTrial requires subjectId");

  const everHad = await Subscription.countDocuments({ subjectId });
  if (everHad > 0) {
    return { granted: false, reason: "This account has already used its trial." };
  }

  const plan = await Plan.findOne({ slug: planSlug }).lean();
  if (!plan) return { granted: false, reason: `No "${planSlug}" plan is configured.` };

  const days = plan.trialDays || plan.durationDays;
  const startsAt = new Date();
  const subscription = await Subscription.create({
    subjectId,
    subjectType,
    planId: plan._id,
    planSlug: plan.slug,
    grantedPermissions: [...(plan.permissionKeys || [])],
    pricePaidRupees: 0,
    status: "trialing",
    startsAt,
    expiresAt: new Date(startsAt.getTime() + days * DAY_MS),
  });

  return { granted: true, subscription };
}

/**
 * Grant a trial without ever being able to break account creation.
 *
 * A billing failure must not stop someone signing up — the account is the
 * valuable thing; the trial can be granted later by hand. Logs loudly instead
 * of throwing, and is safe to call from any creation path (grantTrial itself
 * refuses a second one).
 */
async function grantTrialSafe({ subjectId, subjectType }) {
  try {
    const res = await grantTrial({ subjectId, subjectType });
    if (!res.granted) {
      console.warn(`[trial] not granted for ${subjectType} ${subjectId}: ${res.reason}`);
    }
    return res;
  } catch (err) {
    console.error(`[trial] FAILED for ${subjectType} ${subjectId}: ${err.message}`);
    return { granted: false, reason: err.message };
  }
}

/**
 * Open a Razorpay order for a plan.
 *
 * `amountPaise` is passed in already derived from the Plan by the caller — it
 * is never taken from a request body (Trap 4 / defect-tracker §2.4).
 *
 * The billing subject is written onto the payment record HERE, at order time,
 * because the webhook fires server-to-server with no auth context and cannot
 * resolve who to activate later.
 */
async function openSubscriptionOrder({ plan, subject, amountPaise, userId = null }) {
  const receipt = `sub_${Date.now().toString(36)}`;

  const payment = await RazorpayPayment.create({
    userId,
    purpose: "subscription",
    refId: plan._id,
    amountPaise,
    receipt,
    notes: { subjectId: subject.id, subjectType: subject.type, planSlug: plan.slug },
  });

  const order = await rp.createOrder({
    amountPaise,
    receipt,
    notes: {
      purpose: "subscription",
      planId: String(plan._id),
      paymentId: String(payment._id),
      subjectId: subject.id,
    },
  });

  payment.razorpayOrderId = order.id;
  await payment.save();

  return { order, payment };
}

module.exports = {
  activateFromPayment,
  grantTrial,
  grantTrialSafe,
  findLive,
  openSubscriptionOrder,
};

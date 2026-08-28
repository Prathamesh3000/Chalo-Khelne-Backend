/**
 * Billing — what the CURRENT caller holds.
 *
 * Feeds the client so it can hide features the caller has not bought. That is
 * a courtesy, never a control: the server gate is requirePermission, and
 * hiding a button while leaving its endpoint open is not a paywall (Trap 5).
 */
const { getBillingSubjectId, getBillingSubject, getTenant } = require("../utils/tenantContext");
const { activeSubscription } = require("../utils/entitlements");
const { resolveCallerRole } = require("../middleware/rbacMiddleware");
const planService = require("../services/planService");
const { openSubscriptionOrder } = require("../services/subscriptionService");
const rp = require("../utils/razorpay");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from now until `date`, floored at 0. */
function daysUntil(date) {
  if (!date) return null;
  return Math.max(0, Math.ceil((new Date(date).getTime() - Date.now()) / DAY_MS));
}

// GET /api/billing/me
exports.getMyBilling = async (req, res) => {
  const subjectId = getBillingSubjectId();
  const ctx = getTenant() || {};

  // Base role permissions — the floor, held whether or not anything is bought.
  let rolePermissions = [];
  try {
    const role = await resolveCallerRole(req);
    if (role && Array.isArray(role.permissions)) {
      rolePermissions = role.permissions
        .filter((p) => p && p.isActive !== false)
        .map((p) => (typeof p === "string" ? p : p.key));
    }
  } catch (err) {
    // A role lookup failure must not blank the billing screen; report the
    // subscription and let the UI degrade to showing nothing as unlocked.
    console.warn(`[billing] role lookup failed: ${err.message}`);
  }

  // SuperAdmin bypasses every permission check, so "what have you bought" is
  // not a meaningful question for them. Answer honestly rather than inventing
  // a subscription.
  if (ctx.isSuperAdmin) {
    return res.json({
      success: true,
      isSuperAdmin: true,
      subjectId: null,
      subscription: null,
      rolePermissions,
      purchasedPermissions: [],
      effectivePermissions: rolePermissions,
    });
  }

  const sub = subjectId ? await activeSubscription(subjectId) : null;
  const purchasedPermissions = (sub && sub.grantedPermissions) || [];

  return res.json({
    success: true,
    isSuperAdmin: false,
    subjectId: subjectId || null,
    subjectType: sub ? sub.subjectType : null,
    // null means "no live subscription" — the caller is on their base role.
    subscription: sub
      ? {
          planSlug: sub.planSlug || null,
          planId: sub.planId || null,
          status: sub.status,
          startsAt: sub.startsAt,
          expiresAt: sub.expiresAt,
          daysRemaining: daysUntil(sub.expiresAt),
          isComped: !!sub.isComped,
          pricePaidRupees: sub.pricePaidRupees,
        }
      : null,
    rolePermissions,
    purchasedPermissions,
    // The union the server actually enforces — what the UI should key off.
    effectivePermissions: [
      ...new Set([...rolePermissions, ...purchasedPermissions]),
    ],
  });
};

// GET /api/billing/plans
//
// The plans THIS caller may buy. Audience is derived from who they are, not
// from a query parameter — a club must not be shown vendor pricing, and a
// caller must not be able to widen the list by asking.
exports.listAvailablePlans = async (req, res) => {
  const subject = getBillingSubject();
  if (!subject) {
    return res.status(403).json({
      success: false,
      message: "Only club and vendor accounts can hold a subscription.",
    });
  }

  const plans = await planService.listPurchasable(subject.type);

  const current = await activeSubscription(subject.id);

  return res.json({
    success: true,
    audience: subject.type,
    currentPlanSlug: current ? current.planSlug : null,
    plans,
  });
};

// POST /api/billing/subscribe   { planId }
//
// Opens a Razorpay order for a plan.
//
// ── THE RULE (Trap 4 / §2.4) ──
// The amount is read from the Plan document, server-side, by id. No amount is
// accepted from the request body at all — not read, not defaulted, not
// validated-then-overwritten. A ₹300 plan cannot be bought for ₹1 by editing
// one request, because there is nothing in the request to edit.
exports.createSubscriptionOrder = async (req, res) => {
  if (!rp.isConfigured()) {
    return res.status(503).json({ success: false, message: "Payments are not configured yet." });
  }

  const subject = getBillingSubject();
  if (!subject) {
    return res.status(403).json({
      success: false,
      message: "Only club and vendor accounts can hold a subscription.",
    });
  }

  const { planId } = req.body;
  if (!planId) {
    return res.status(400).json({ success: false, message: "planId is required" });
  }

  const plan = await planService.findPurchasableById(planId);
  if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });

  if (!plan.isActive) {
    return res.status(409).json({ success: false, message: "This plan is no longer available." });
  }
  // A club must not be able to buy a vendor plan by passing its id directly.
  if (plan.audience !== subject.type) {
    return res.status(403).json({ success: false, message: "This plan is not available to your account type." });
  }
  if (plan.priceRupees <= 0) {
    return res.status(400).json({
      success: false,
      message: "This plan has no price and cannot be purchased. Free access is granted, not bought.",
    });
  }

  // Derived. Never from req.body.
  const amountPaise = plan.priceRupees * 100;

  const { order, payment } = await openSubscriptionOrder({
    plan,
    subject,
    amountPaise,
    userId: req.user?._id || req.user?.id || null,
  });

  return res.status(201).json({
    success: true,
    key: rp.publicKeyId(),
    orderId: order.id,
    amountPaise,
    amountRupees: plan.priceRupees,
    currency: "INR",
    paymentId: String(payment._id),
    plan: { name: plan.name, slug: plan.slug, durationDays: plan.durationDays },
  });
};

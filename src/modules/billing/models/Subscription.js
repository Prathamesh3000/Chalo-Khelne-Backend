const mongoose = require("mongoose");

/**
 * Subscription — what a billing subject has bought, and until when.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO tenantScope PLUGIN ON THIS MODEL
 * ─────────────────────────────────────────────────────────────────────────
 * Almost every other model in src/modules carries
 * `schema.plugin(tenantScope, { field: "clubId", enforce: true })`, so its
 * absence here looks like an oversight. It is not — adding it would open a
 * leak.
 *
 * tenantScope's query hook begins:
 *
 *     if (!t || t.isSuperAdmin || !t.clubId) return next();   // no filtering
 *
 * A vendor is a billing subject but deliberately NOT a data tenant, so a
 * vendor's request context carries no clubId (see utils/tenantContext.js).
 * The plugin would therefore skip filtering for vendors specifically — and a
 * vendor calling Subscription.find({}) would read every club's subscription.
 *
 * So isolation here is EXPLICIT, never ambient: every read is scoped by
 * subjectId, and all access goes through utils/entitlements.js, which always
 * passes one. Never add tenantScope to this schema.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE FIELD IS subjectId AND NOT clubId
 * ─────────────────────────────────────────────────────────────────────────
 * A vendor's subject id is their own User id and is not a club. Calling it
 * clubId would be inaccurate, and would invite exactly the plugin call the
 * block above forbids.
 */
const subscriptionSchema = new mongoose.Schema(
  {
    // WHO is subscribed. For a club this equals the tenant clubId; for a
    // vendor it is their own User id. Resolved per-request by
    // tenantContext.getBillingSubjectId().
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    subjectType: {
      type: String,
      enum: ["club", "vendor"],
      required: true,
    },

    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null },

    // Denormalised for reporting, so a deleted plan doesn't orphan the record.
    planSlug: { type: String, default: "", trim: true },

    // ── SNAPSHOT, not a live join ──
    // The permissions as they stood WHEN THIS WAS BOUGHT. If SuperAdmin later
    // edits the plan, existing subscribers keep exactly what they paid for;
    // the edit applies to new purchases and renewals. Resolving through planId
    // instead would silently change — or remove — a paid-for feature mid-term.
    grantedPermissions: { type: [String], default: [] },

    // Whole rupees actually charged (may differ from the plan's current price).
    pricePaidRupees: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "pricePaidRupees must be a whole number of rupees",
      },
    },

    status: {
      type: String,
      enum: ["trialing", "active", "expired", "cancelled"],
      required: true,
      index: true,
    },

    startsAt: { type: Date, required: true },

    // The whole expiry mechanism. Access is decided by comparing this to now()
    // AT READ TIME — there is no job that revokes anything, so there is no job
    // that can fail and leave someone permanently upgraded.
    expiresAt: { type: Date, required: true, index: true },

    // Idempotency key for activation. Razorpay retries webhooks, and /verify
    // may also fire for the same payment, so activation must be safe to run
    // more than once. Uniqueness is enforced by a PARTIAL index (see below),
    // not a sparse one — trial and comped rows legitimately have no order id.
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },

    // True for subscriptions issued by the grandfathering migration rather
    // than bought. Keeps "who actually pays us" answerable.
    isComped: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    strict: "throw",
  }
);

// The hot path: "what does this subject have live right now?" — every
// permission check on a subscribed principal runs this.
subscriptionSchema.index({ subjectId: 1, status: 1, expiresAt: -1 });

// One row per gateway order.
//
// PARTIAL, not sparse. `sparse` only skips documents where the field is
// ABSENT — and razorpayOrderId defaults to null, so it is always present.
// Every trial and comped subscription would therefore index as null and the
// SECOND one ever created would fail with E11000. (Caught by
// tests/integration/billingModels.test.js before it reached anyone.)
//
// A partial index on $type:"string" indexes only rows that actually carry a
// gateway order id, so unlimited null-order rows coexist while a real order
// can still activate exactly one subscription.
subscriptionSchema.index(
  { razorpayOrderId: 1 },
  {
    unique: true,
    partialFilterExpression: { razorpayOrderId: { $type: "string" } },
  }
);

module.exports = mongoose.model("Subscription", subscriptionSchema);

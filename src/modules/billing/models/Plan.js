const mongoose = require("mongoose");

/**
 * Plan — a purchasable bundle of permissions, composed by SuperAdmin.
 *
 * Mirrors the shape the platform already uses for access control:
 *
 *    Permission  (code, seeded)   →   Role  (data, SuperAdmin-composed)
 *    Permission  (code, seeded)   →   Plan  (data, SuperAdmin-composed) + price
 *
 * `permissionKeys` deliberately reuses the EXISTING Permission catalogue rather
 * than introducing a parallel "feature" concept. Every key already has a real
 * enforcement point (requirePermission on a route), so a plan cannot promise
 * something the code does not actually gate.
 *
 * Money convention (§7.2): whole rupees, integer. No paise, no floats.
 */
const planSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9_]+$/, "Slug must be lowercase letters, digits or underscores"],
    },

    description: { type: String, trim: true, default: "" },

    // Whole rupees. 0 is legal — that is the free tier.
    priceRupees: {
      type: Number,
      required: true,
      min: [0, "Price cannot be negative"],
      validate: {
        validator: Number.isInteger,
        message: "priceRupees must be a whole number of rupees (no paise, no floats)",
      },
    },

    // How long a purchase of this plan lasts. Drives Subscription.expiresAt.
    durationDays: {
      type: Number,
      required: true,
      min: [1, "A plan must last at least one day"],
      validate: {
        validator: Number.isInteger,
        message: "durationDays must be a whole number of days",
      },
    },

    // Free days granted before the plan is paid for. 7 on the trial plan, 0 on
    // paid plans. A trial uses the SAME machinery as a purchase — there is no
    // separate trial code path.
    trialDays: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "trialDays must be a whole number of days",
      },
    },

    // Permission keys this plan grants ON TOP OF the subscriber's base role.
    // A plan only ever ADDS; it never subtracts, so a lapsed subscription can
    // never drop a customer below what their role already allows.
    permissionKeys: {
      type: [String],
      default: [],
    },

    // Who is offered this plan. Clubs and vendors buy different things.
    audience: {
      type: String,
      enum: ["club", "vendor"],
      required: true,
      index: true,
    },

    // isActive  — false retires a plan: existing subscribers keep what they
    //             bought (their permissions are snapshotted), but nobody new
    //             can purchase it.
    // isPublic  — false hides it from the customer-facing list while leaving it
    //             purchasable by direct id (private/negotiated pricing).
    isActive: { type: Boolean, default: true, index: true },
    isPublic: { type: Boolean, default: true },

    sortOrder: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    // Same posture as the money schemas (BookingModel, TournamentAttendance):
    // an unexpected field is a loud failure, not a silent drop.
    strict: "throw",
  }
);

// The customer-facing list query: active + public, for one audience, in order.
planSchema.index({ audience: 1, isActive: 1, isPublic: 1, sortOrder: 1 });

module.exports = mongoose.model("Plan", planSchema);

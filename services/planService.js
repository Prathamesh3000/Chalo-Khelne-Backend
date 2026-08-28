"use strict";
/**
 * Plan data access.
 *
 * Exists so controllers don't reach into models directly — the
 * `legacy-controller-direct-model` boundary rule (.dependency-cruiser.js)
 * fails CI on any NEW controller→model import, and the billing module has no
 * reason to add to that debt. `services/` is the sanctioned place for model
 * access, as couponService and notificationService already do.
 */
const Plan = require("../src/modules/billing/models/Plan");
const Subscription = require("../src/modules/billing/models/Subscription");
const Permission = require("../src/modules/identity/models/Permission");

const LIVE = { status: { $in: ["trialing", "active"] } };

/**
 * Permission keys that are NOT in the catalogue.
 *
 * A plan promising a key that does not exist would store fine and then never
 * match at check time — the customer pays and the feature silently never
 * unlocks, with nothing in the logs to explain it.
 */
async function unknownPermissionKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const found = await Permission.find({ key: { $in: keys } }).select("key").lean();
  const known = new Set(found.map((p) => p.key));
  return keys.filter((k) => !known.has(k));
}

/** Live subscriber counts per plan, as a Map keyed by plan id string. */
async function activeSubscriberCounts() {
  const rows = await Subscription.aggregate([
    { $match: { ...LIVE, expiresAt: { $gt: new Date() } } },
    { $group: { _id: "$planId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

function countSubscribers(planId, { liveOnly = true } = {}) {
  const filter = { planId };
  if (liveOnly) Object.assign(filter, LIVE, { expiresAt: { $gt: new Date() } });
  return Subscription.countDocuments(filter);
}

// ── admin reads ──────────────────────────────────────────────────────

function findAll({ audience, active } = {}) {
  const filter = {};
  if (audience) filter.audience = audience;
  if (active !== undefined) filter.isActive = active;
  return Plan.find(filter).sort({ audience: 1, sortOrder: 1, priceRupees: 1 });
}

const findById = (id) => Plan.findById(id);
const findBySlug = (slug) => Plan.findOne({ slug: String(slug).toLowerCase() });

// ── customer read ────────────────────────────────────────────────────

/** Purchasable plans for one audience. Retired and unlisted plans excluded. */
function listPurchasable(audience) {
  return Plan.find({ audience, isActive: true, isPublic: true })
    .sort({ sortOrder: 1, priceRupees: 1 })
    .select("name slug description priceRupees durationDays trialDays permissionKeys sortOrder")
    .lean();
}

/** A plan for purchase, as a plain object. Null when the id is malformed. */
async function findPurchasableById(id) {
  try {
    return await Plan.findById(id).lean();
  } catch {
    return null; // CastError on a junk id is a 404, not a 500
  }
}

// ── writes ───────────────────────────────────────────────────────────

const create = (doc) => Plan.create(doc);

async function remove(plan) {
  await plan.deleteOne();
}

module.exports = {
  unknownPermissionKeys,
  activeSubscriberCounts,
  countSubscribers,
  findAll,
  findById,
  findBySlug,
  listPurchasable,
  findPurchasableById,
  create,
  remove,
};

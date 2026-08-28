/**
 * Seed starter plans.
 *
 * ⚠️  PLACEHOLDER PRICING AND TIER CONTENTS.
 *
 * The real split of the 22 sellable permissions across tiers is decision D2 in
 * PRICING_MODULE_PLAN.md and has not been made. These exist so the SuperAdmin
 * Plans tab and the purchase flow have something to run against. SuperAdmin
 * composes the real plans in the UI — plans are data, not code, so nothing
 * here needs a deploy to change.
 *
 * Idempotent: re-running updates a plan in place by slug and never duplicates.
 * It will NOT overwrite a plan an operator has edited unless --force is passed,
 * so a seed run cannot silently undo real pricing work.
 *
 *   node scripts/seedPlans.js
 *   node scripts/seedPlans.js --force
 */
const Plan = require("../src/modules/billing/models/Plan");
const Permission = require("../src/modules/identity/models/Permission");

// The 9 keys that stay in the base club_admin role (Phase 3). Listed here only
// so the trial's contents can be described relative to them.
const FREE_TIER = [
  "tournament:read", "tournament:create", "tournament:update", "tournament:delete",
  "tournament:manage", "tournament:score",
  "booking:read", "player:read", "manager:read",
];

// Draft split of the sellable keys. Correct these once D2 is decided.
const STARTER_EXTRAS = [
  "tournament:bulk_register",
  "tournament:export",
  "booking:approve",
  "player:view_all",
];

const PRO_EXTRAS = [
  ...STARTER_EXTRAS,
  "payment:read", "payment:approve",
  "expense:create", "expense:read",
  "referee:assign", "referee:read",
  "report:view_all",
  "turf:read", "turf:create", "turf:update", "turf:delete",
  "news:create", "news:update", "news:publish",
  "social:create", "social:delete",
  "manager:create", "manager:delete",
];

const DEFAULT_PLANS = [
  {
    name: "Trial",
    slug: "trial",
    description:
      "7 days of the full Pro feature set. Drops to the free tier when it ends — a running tournament is never interrupted.",
    priceRupees: 0,
    durationDays: 7,
    trialDays: 7,
    audience: "club",
    permissionKeys: PRO_EXTRAS,
    isPublic: false, // granted on signup, not bought from the plans list
    sortOrder: 0,
  },
  {
    name: "Starter",
    slug: "starter",
    description: "Bulk registration, exports and booking approval on top of core tournament management.",
    priceRupees: 100,
    durationDays: 30,
    audience: "club",
    permissionKeys: STARTER_EXTRAS,
    // UNLISTED until pricing is confirmed (D2). The price below is a
    // placeholder, and an unlisted plan cannot be bought by mistake at a
    // figure nobody agreed to. Flip "Listed to customers" on in the
    // SuperAdmin Plans tab once the real number is set — no deploy needed.
    isPublic: false,
    sortOrder: 1,
  },
  {
    name: "Pro",
    slug: "pro",
    description: "Everything: payments, finance, referees, venues, analytics and content.",
    priceRupees: 300,
    durationDays: 30,
    audience: "club",
    permissionKeys: PRO_EXTRAS,
    isPublic: false, // placeholder price — see Starter above
    sortOrder: 2,
  },
  {
    name: "Vendor Store",
    slug: "vendor_store",
    description: "Storefront listing and order management for equipment sellers.",
    priceRupees: 100,
    durationDays: 30,
    audience: "vendor",
    isPublic: false, // placeholder price — see Starter above
    // Vendor routes still use the legacy requireRole("vendor") gate rather than
    // requirePermission, so there is nothing meaningful to grant yet. Populated
    // when those routes move onto RBAC.
    permissionKeys: [],
    sortOrder: 1,
  },
];

/**
 * Drop any key that isn't in the Permission catalogue, loudly.
 *
 * The seed must not create a plan promising a permission that does not exist —
 * it would store fine and never match at check time.
 */
async function filterToKnownKeys(keys) {
  if (!keys.length) return [];
  const found = await Permission.find({ key: { $in: keys } }).select("key").lean();
  const known = new Set(found.map((p) => p.key));
  const missing = keys.filter((k) => !known.has(k));
  if (missing.length) {
    console.warn(
      `[seedPlans] dropping ${missing.length} key(s) absent from the Permission ` +
        `catalogue: ${missing.join(", ")}. Run scripts/seedRbac first.`
    );
  }
  return keys.filter((k) => known.has(k));
}

async function seedPlans({ force = false } = {}) {
  const results = [];

  for (const def of DEFAULT_PLANS) {
    const permissionKeys = await filterToKnownKeys(def.permissionKeys);
    const existing = await Plan.findOne({ slug: def.slug });

    if (!existing) {
      await Plan.create({ ...def, permissionKeys });
      results.push({ slug: def.slug, action: "created" });
      continue;
    }

    if (!force) {
      results.push({
        slug: def.slug,
        action: "skipped (already exists — pass --force to overwrite)",
      });
      continue;
    }

    Object.assign(existing, def, { permissionKeys });
    await existing.save();
    results.push({ slug: def.slug, action: "overwritten" });
  }

  return results;
}

module.exports = seedPlans;
module.exports.DEFAULT_PLANS = DEFAULT_PLANS;
module.exports.FREE_TIER = FREE_TIER;
module.exports.STARTER_EXTRAS = STARTER_EXTRAS;
module.exports.PRO_EXTRAS = PRO_EXTRAS;

// ── CLI ───────────────────────────────────────────────────────────────
if (require.main === module) {
  require("dotenv").config();
  const { connectDb, disconnectDb } = require("./lib/connectDb");
  const force = process.argv.includes("--force");

  (async () => {
    try {
      await connectDb();
      const results = await seedPlans({ force });
      for (const r of results) console.log(`  ${r.slug.padEnd(14)} ${r.action}`);
      console.log("");
      console.log("[seedPlans] done.");
      console.log("  TRIAL is live - new signups get their 7 days.");
      console.log("  Paid plans are UNLISTED so nobody can buy at a placeholder price.");
      console.log("  Set real tiers/prices in SuperAdmin > Plans, then tick Listed to customers.");
      await disconnectDb();
      process.exit(0);
    } catch (err) {
      console.error("[seedPlans] failed:", err.message);
      process.exit(1);
    }
  })();
}

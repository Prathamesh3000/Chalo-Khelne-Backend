/**
 * Phase 3 — trim the club_admin base role to the free tier, and decide what
 * happens to the clubs who hold the other 22 permissions today.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE SCRIPT THAT MAKES THE PAYWALL REAL.
 * ─────────────────────────────────────────────────────────────────────────
 * Until it runs, every club still carries all 31 permissions from the shared
 * club_admin role and there is nothing to sell. After it runs, 22 of those
 * move behind plans.
 *
 * ── The decision this script refuses to make for you (D1) ──
 *
 *   --mode=grandfather   Every existing club gets a comped subscription
 *                        carrying the 22 permissions they hold today, so
 *                        NOBODY loses a feature on deploy day. You convert
 *                        them at renewal. RECOMMENDED.
 *
 *   --mode=cut           Trim only. Existing clubs drop to the free tier
 *                        immediately and must buy to get anything back.
 *                        Faster to revenue; strips features from live
 *                        customers overnight with no warning.
 *
 * There is no default. Passing no mode prints this choice and exits, because
 * picking one silently is not a decision anyone should inherit from a script.
 *
 * ── Safety ──
 *   • DRY RUN by default. Nothing is written without --apply.
 *   • Idempotent — re-running changes nothing further.
 *   • Reversible — `--rollback` restores the pre-trim role and removes the
 *     comped subscriptions this script created (identified by planSlug).
 *
 *   node scripts/migrateBillingBaseline.js --mode=grandfather
 *   node scripts/migrateBillingBaseline.js --mode=grandfather --apply
 *   node scripts/migrateBillingBaseline.js --rollback --apply
 */
require("dotenv").config();
const { connectDb, disconnectDb } = require("./lib/connectDb");

const Role = require("../src/modules/identity/models/Role");
const Permission = require("../src/modules/identity/models/Permission");
const User = require("../src/modules/identity/models/User");
const Subscription = require("../src/modules/billing/models/Subscription");

// ── The split (see PRICING_MODULE_PLAN.md §4) ────────────────────────

/** Stays in the base role. Core tournament management, free forever. */
const FREE_TIER = [
  "tournament:read", "tournament:create", "tournament:update", "tournament:delete",
  "tournament:manage", "tournament:score",
  "booking:read", "player:read", "manager:read",
];

/**
 * The pre-trim club_admin definition, preserved verbatim so --rollback can
 * restore it exactly. Do NOT "tidy" this list — it is a record of what the
 * role held before the migration, not a live configuration.
 */
const PRE_TRIM_CLUB_ADMIN = [
  "tournament:read", "tournament:create", "tournament:update", "tournament:delete",
  "tournament:manage", "tournament:score", "tournament:export", "tournament:bulk_register",
  "turf:read", "turf:create", "turf:update", "turf:delete",
  "booking:read", "booking:approve",
  "player:read", "player:view_all",
  "manager:create", "manager:read", "manager:delete",
  "news:create", "news:update", "news:publish",
  "payment:read", "payment:approve",
  "expense:create", "expense:read",
  "referee:assign", "referee:read",
  "social:create", "social:delete",
  "report:view_all",
];

/** What a grandfathered club keeps: everything they had, minus the free tier. */
const GRANDFATHERED = PRE_TRIM_CLUB_ADMIN.filter((k) => !FREE_TIER.includes(k));

// Marks the rows this script created, so rollback can find them and normal
// business reporting can exclude them from "who actually pays us".
const COMPED_SLUG = "grandfathered";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── helpers ──────────────────────────────────────────────────────────

async function permissionIdsFor(keys) {
  const docs = await Permission.find({ key: { $in: keys } }).select("_id key").lean();
  const found = new Set(docs.map((d) => d.key));
  const missing = keys.filter((k) => !found.has(k));
  if (missing.length) {
    throw new Error(
      `Permission catalogue is missing ${missing.length} key(s): ${missing.join(", ")}. ` +
        `Run scripts/seedRbac first — trimming against an incomplete catalogue would ` +
        `silently drop permissions.`
    );
  }
  return docs.map((d) => d._id);
}

function tenantOwners() {
  return User.find({ role: { $in: ["ClubAdmin", "corporate_admin"] } })
    .select("_id name email role")
    .lean();
}

// ── main ─────────────────────────────────────────────────────────────

async function run({ mode, apply, rollback, days }) {
  const log = (...a) => console.log(...a);
  const willWrite = apply ? "" : "  [dry run — nothing written]";

  const role = await Role.findOne({ slug: "club_admin" }).populate("permissions");
  if (!role) throw new Error('No club_admin role found. Run scripts/seedRbac first.');

  const currentKeys = (role.permissions || []).map((p) => p.key);

  // ── rollback ──
  if (rollback) {
    log(`\nROLLBACK${willWrite}`);
    log(`  club_admin: ${currentKeys.length} → ${PRE_TRIM_CLUB_ADMIN.length} permissions`);

    const comped = await Subscription.countDocuments({ planSlug: COMPED_SLUG });
    log(`  comped subscriptions to remove: ${comped}`);

    if (apply) {
      role.permissions = await permissionIdsFor(PRE_TRIM_CLUB_ADMIN);
      await role.save();
      const del = await Subscription.deleteMany({ planSlug: COMPED_SLUG });
      log(`  restored role; removed ${del.deletedCount} comped subscription(s)`);
    }
    return;
  }

  // ── forward ──
  const alreadyTrimmed =
    currentKeys.length === FREE_TIER.length &&
    FREE_TIER.every((k) => currentKeys.includes(k));

  log(`\nMODE: ${mode}${willWrite}`);
  log(`  club_admin currently holds ${currentKeys.length} permission(s)`);
  if (alreadyTrimmed) {
    log("  role is already trimmed — nothing to do for the role");
  } else {
    log(`  → trimming to ${FREE_TIER.length}: ${FREE_TIER.join(", ")}`);
    log(`  → ${GRANDFATHERED.length} permission(s) move behind plans`);
  }

  const owners = await tenantOwners();
  log(`\n  ${owners.length} existing club/corporate account(s) found`);

  if (mode === "grandfather") {
    const expiresAt = new Date(Date.now() + days * DAY_MS);
    let toCreate = 0;
    let skipped = 0;

    for (const owner of owners) {
      // Never overwrite a real subscription, and never issue two comped rows.
      const existing = await Subscription.findOne({
        subjectId: owner._id,
        status: { $in: ["trialing", "active"] },
        expiresAt: { $gt: new Date() },
      }).lean();

      if (existing) {
        skipped += 1;
        continue;
      }
      toCreate += 1;

      if (apply) {
        await Subscription.create({
          subjectId: owner._id,
          subjectType: "club",
          planId: null,
          planSlug: COMPED_SLUG,
          grantedPermissions: [...GRANDFATHERED],
          pricePaidRupees: 0,
          status: "active",
          startsAt: new Date(),
          expiresAt,
          isComped: true,
        });
      }
    }

    log(`  → comped subscriptions to issue: ${toCreate}`);
    log(`  → skipped (already have a live subscription): ${skipped}`);
    log(`  → comped access valid until ${expiresAt.toDateString()} (${days} days)`);
  } else {
    log("  → cut clean: NO comped subscriptions issued.");
    log(`  → ${owners.length} account(s) drop to the free tier immediately.`);
  }

  if (!alreadyTrimmed && apply) {
    role.permissions = await permissionIdsFor(FREE_TIER);
    await role.save();
    log("\n  club_admin role trimmed.");
  }

  if (!apply) {
    log("\n  Nothing was written. Re-run with --apply to commit.");
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const modeArg = argv.find((a) => a.startsWith("--mode="));
  const daysArg = argv.find((a) => a.startsWith("--days="));
  return {
    mode: modeArg ? modeArg.split("=")[1] : null,
    apply: argv.includes("--apply"),
    rollback: argv.includes("--rollback"),
    days: daysArg ? Number(daysArg.split("=")[1]) : 365,
  };
}

function usage() {
  console.log(`
This migration makes the paywall real, and it will not choose for you.

  --mode=grandfather   Existing clubs keep their current 22 permissions via a
                       comped subscription. Nobody loses anything on deploy
                       day; you convert them at renewal.  RECOMMENDED.

  --mode=cut           Trim only. Existing clubs drop to the free tier now.

  --apply              Actually write. Without it this is a dry run.
  --days=N             How long comped access lasts (default 365).
  --rollback           Restore the pre-trim role and remove comped rows.

  node scripts/migrateBillingBaseline.js --mode=grandfather
  node scripts/migrateBillingBaseline.js --mode=grandfather --apply
`);
}

module.exports = run;
module.exports.FREE_TIER = FREE_TIER;
module.exports.PRE_TRIM_CLUB_ADMIN = PRE_TRIM_CLUB_ADMIN;
module.exports.GRANDFATHERED = GRANDFATHERED;
module.exports.COMPED_SLUG = COMPED_SLUG;

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  if (!args.rollback && !["grandfather", "cut"].includes(args.mode)) {
    usage();
    process.exit(1);
  }

  (async () => {
    try {
      await connectDb();
      await run(args);
      await disconnectDb();
      process.exit(0);
    } catch (err) {
      console.error("\n[migrateBillingBaseline] failed:", err.message);
      process.exit(1);
    }
  })();
}

const Permission = require("../src/modules/identity/models/Permission");
const Role = require("../src/modules/identity/models/Role");

// ═══════════════════════════════════════════════════════════════
// 34 DEFAULT PERMISSIONS ACROSS 13 MODULES
// ═══════════════════════════════════════════════════════════════

const DEFAULT_PERMISSIONS = [
  // ── Tournament (9) ──
  { key: "tournament:create", name: "Create Tournament", module: "tournament", action: "create" },
  { key: "tournament:read", name: "View Tournaments", module: "tournament", action: "read" },
  { key: "tournament:update", name: "Edit Tournament", module: "tournament", action: "update" },
  { key: "tournament:delete", name: "Delete Tournament", module: "tournament", action: "delete" },
  { key: "tournament:manage", name: "Manage Tournament (Bracket/Groups/Courts/Stage)", module: "tournament", action: "manage" },
  { key: "tournament:score", name: "Score Tournament Matches", module: "tournament", action: "score" },
  { key: "tournament:export", name: "Export Tournament Data", module: "tournament", action: "export" },
  { key: "tournament:register", name: "Self-register for a Tournament", module: "tournament", action: "register" },
  { key: "tournament:bulk_register", name: "Bulk-register Players", module: "tournament", action: "bulk_register" },

  // ── Turf / Facility (4) ──
  { key: "turf:create", name: "Create Turf", module: "turf", action: "create" },
  { key: "turf:read", name: "View Turfs", module: "turf", action: "read" },
  { key: "turf:update", name: "Edit Turf", module: "turf", action: "update" },
  { key: "turf:delete", name: "Delete Turf", module: "turf", action: "delete" },

  // ── Booking (4) ──
  { key: "booking:create", name: "Create Booking", module: "booking", action: "create" },
  { key: "booking:read", name: "View Bookings", module: "booking", action: "read" },
  { key: "booking:approve", name: "Approve/Reject Booking", module: "booking", action: "approve" },
  { key: "booking:delete", name: "Cancel Booking", module: "booking", action: "delete" },

  // ── Player (3) ──
  { key: "player:read", name: "View Players", module: "player", action: "read" },
  { key: "player:update", name: "Edit Player Profile", module: "player", action: "update" },
  { key: "player:view_all", name: "View All Players", module: "player", action: "view_all" },

  // ── Manager (3) ──
  { key: "manager:create", name: "Create Manager", module: "manager", action: "create" },
  { key: "manager:read", name: "View Managers", module: "manager", action: "read" },
  { key: "manager:delete", name: "Remove Manager", module: "manager", action: "delete" },

  // ── News (3) ──
  { key: "news:create", name: "Create News", module: "news", action: "create" },
  { key: "news:update", name: "Edit News", module: "news", action: "update" },
  { key: "news:publish", name: "Publish News", module: "news", action: "publish" },

  // ── Payment (2) ──
  { key: "payment:read", name: "View Payments", module: "payment", action: "read" },
  { key: "payment:approve", name: "Verify Payments", module: "payment", action: "approve" },

  // ── Expense (2) ──
  { key: "expense:create", name: "Create Expense", module: "expense", action: "create" },
  { key: "expense:read", name: "View Expenses", module: "expense", action: "read" },

  // ── Referee (2) ──
  { key: "referee:assign", name: "Assign Referee", module: "referee", action: "assign" },
  { key: "referee:read", name: "View Referees", module: "referee", action: "read" },

  // ── Social / Posts (2) ──
  { key: "social:create", name: "Create Post", module: "social", action: "create" },
  { key: "social:delete", name: "Delete Any Post", module: "social", action: "delete" },

  // ── Sport Config (1) ──
  { key: "sport:manage", name: "Manage Sports Config", module: "sport", action: "manage" },

  // ── Report (1) ──
  { key: "report:view_all", name: "View All Reports & Analytics", module: "report", action: "view_all" },

  // ── Role & Permission (1) ──
  { key: "role:manage", name: "Manage Roles & Permissions", module: "role", action: "manage" },

  // ── User lifecycle (3) — SuperAdmin-only ──
  { key: "users:suspend", name: "Suspend or Reject Users", module: "users", action: "suspend", description: "Suspend or reject any user account" },
  { key: "users:reactivate", name: "Reactivate Users", module: "users", action: "reactivate", description: "Reactivate a suspended or rejected user" },
  { key: "users:view_suspended", name: "View Suspended Users", module: "users", action: "read", description: "View all suspended and rejected users" },
];

// ═══════════════════════════════════════════════════════════════
// 6 DEFAULT ROLES WITH PERMISSION ASSIGNMENTS
// ═══════════════════════════════════════════════════════════════

const DEFAULT_ROLES = [
  {
    name: "Super Admin",
    slug: "super_admin",
    authorityLevel: 0,
    description: "Full platform access. Bypasses all permission checks.",
    color: "#DC2626",
    icon: "shield",
    isSystem: true,
    // SuperAdmin gets ALL permissions (and bypasses checks anyway)
    permissionKeys: DEFAULT_PERMISSIONS.map((p) => p.key),
  },
  {
    name: "Club Admin",
    slug: "club_admin",
    authorityLevel: 1,
    description: "Club-level admin. Core tournament management; everything else comes from a plan.",
    color: "#7C3AED",
    icon: "building",
    isSystem: true,
    // ══════════════════════════════════════════════════════════════════
    // ⚠️  TRIMMED TO THE FREE TIER (Phase 3 of the pricing module).
    //
    // This role used to seed with 31 permissions. 22 of them are now SOLD via
    // Plans and live on a Subscription instead — see PRICING_MODULE_PLAN.md §4.
    // A plan only ever ADDS to this list, so these 9 are the floor every club
    // keeps forever, subscription or not.
    //
    // ⚠️  RUNNING THIS SEED ON AN EXISTING DEPLOYMENT REWRITES THE LIVE ROLE
    //     AND STRIPS THOSE 22 PERMISSIONS FROM EVERY CLUB AT ONCE.
    //
    //     On an existing database, run the migration instead — it makes the
    //     same change but decides what happens to current customers first:
    //         node scripts/migrateBillingBaseline.js --mode=grandfather --apply
    //
    //     A fresh install has no clubs to protect, so seeding this directly is
    //     correct there.
    // ══════════════════════════════════════════════════════════════════
    permissionKeys: [
      "tournament:read", "tournament:create", "tournament:update", "tournament:delete",
      "tournament:manage", "tournament:score",
      "booking:read",
      "player:read",
      "manager:read",
    ],
  },
  {
    name: "Manager",
    slug: "manager",
    authorityLevel: 2,
    description: "Tournament organizer. Creates and manages tournaments, turfs, bookings.",
    color: "#2563EB",
    icon: "briefcase",
    isSystem: true,
    permissionKeys: [
      "tournament:create", "tournament:read", "tournament:update", "tournament:delete",
      "tournament:manage", "tournament:score", "tournament:export", "tournament:bulk_register",
      "turf:create", "turf:read", "turf:update",
      "booking:read", "booking:approve", "booking:delete",
      "player:read",
      "news:create", "news:update", "news:publish",
      "payment:read", "payment:approve",
      "expense:create", "expense:read",
      "referee:assign", "referee:read",
      "social:create",
    ],
  },
  {
    name: "Trainer",
    slug: "trainer",
    authorityLevel: 3,
    description: "Sports trainer. Manages training sessions and player coaching.",
    color: "#059669",
    icon: "dumbbell",
    isSystem: true,
    permissionKeys: [
      "tournament:read", "tournament:register",
      "booking:create", "booking:read",
      "player:read",
      "social:create",
    ],
  },
  {
    name: "Player",
    slug: "player",
    authorityLevel: 4,
    description: "Registered player. Can book, register, and participate.",
    color: "#0891B2",
    icon: "user",
    isSystem: true,
    permissionKeys: [
      "tournament:read", "tournament:register",
      "turf:read",
      "booking:create", "booking:read", "booking:delete",
      "player:update",
      "social:create",
    ],
  },
  {
    name: "Referee",
    slug: "referee",
    authorityLevel: 3,
    description: "Match referee. Can view assigned matches and update scores, and can enter tournaments as a competitor.",
    color: "#F59E0B",
    icon: "flag",
    isSystem: true,
    permissionKeys: [
      "tournament:read", "tournament:score",
      // A referee is also a person who plays. Officiating one tournament does
      // not stop them entering another, and Trainer — the other non-Player
      // participant role — has always been able to self-register. Without this
      // a referee's booking was rejected with a bare "Access denied".
      "tournament:register",
      "referee:read",
      "player:read",
    ],
  },
  {
    name: "Vendor",
    slug: "vendor",
    authorityLevel: 4,
    description:
      "Equipment seller. Runs a storefront; also participates in tournaments like any other person.",
    color: "#0891B2",
    icon: "store",
    isSystem: true,
    // ── Why these keys, and not store-specific ones ──
    //
    // Every vendor route is still gated by the LEGACY requireRole("vendor")
    // (routes/vendorAccountRoutes.js, routes/vendorStoreRoutes.js), not by
    // requirePermission — so store-specific permission keys would be invented
    // for nothing today. They get added when those routes move onto RBAC.
    //
    // What this list MUST do is preserve behaviour. Until now `vendor` was
    // absent from mapLegacyRole and fell through to "player", so a vendor was
    // silently evaluated against the player role. Mirroring the player
    // participant baseline exactly means fixing the identity bug changes no
    // vendor's access. Same reasoning as Referee above: a vendor is also a
    // person who plays.
    permissionKeys: [
      "tournament:read", "tournament:register",
      "turf:read",
      "booking:create", "booking:read", "booking:delete",
      "player:update",
      "social:create",
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// SEED HANDLER
// ═══════════════════════════════════════════════════════════════

async function seedRbac(req, res) {
  try {
    let permissionsCreated = 0;
    let permissionsSkipped = 0;
    let rolesCreated = 0;
    let rolesUpdated = 0;

    // ── Step 1: Upsert all permissions ──
    const permissionMap = {};
    for (const pDef of DEFAULT_PERMISSIONS) {
      let existing = await Permission.findOne({ key: pDef.key });
      if (existing) {
        permissionsSkipped++;
        permissionMap[pDef.key] = existing._id;
      } else {
        const created = await Permission.create({ ...pDef, isSystem: true });
        permissionsCreated++;
        permissionMap[pDef.key] = created._id;
      }
    }

    // ── Step 2: Upsert all roles ──
    for (const rDef of DEFAULT_ROLES) {
      const permIds = rDef.permissionKeys
        .map((k) => permissionMap[k])
        .filter(Boolean);

      let existing = await Role.findOne({ slug: rDef.slug });
      if (existing) {
        // Update permissions if role exists
        existing.permissions = permIds;
        existing.description = rDef.description;
        existing.color = rDef.color;
        existing.icon = rDef.icon;
        await existing.save();
        rolesUpdated++;
      } else {
        await Role.create({
          name: rDef.name,
          slug: rDef.slug,
          authorityLevel: rDef.authorityLevel,
          description: rDef.description,
          color: rDef.color,
          icon: rDef.icon,
          isSystem: rDef.isSystem,
          permissions: permIds,
        });
        rolesCreated++;
      }
    }

    const summary = {
      permissions: { created: permissionsCreated, skipped: permissionsSkipped, total: DEFAULT_PERMISSIONS.length },
      roles: { created: rolesCreated, updated: rolesUpdated, total: DEFAULT_ROLES.length },
    };

    console.log("[RBAC_SEED] Complete:", JSON.stringify(summary));

    if (res) {
      return res.json({ success: true, message: "RBAC seed complete", ...summary });
    }
    return summary;
  } catch (err) {
    console.error("[RBAC_SEED] Error:", err.message);
    if (res) {
      return res.status(500).json({ success: false, message: err.message });
    }
    throw err;
  }
}

module.exports = seedRbac;
// Exposed for tests and for the targeted grant script — the function stays the
// default export so `require(...)` still works as an Express handler.
module.exports.DEFAULT_ROLES = DEFAULT_ROLES;
module.exports.DEFAULT_PERMISSIONS = DEFAULT_PERMISSIONS;

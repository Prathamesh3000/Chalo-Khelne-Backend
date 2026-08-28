"use strict";
/**
 * Phase 0 checkpoint — vendors become a BILLING subject without becoming a
 * DATA tenant.
 *
 * Why the distinction exists
 * --------------------------
 * The pricing module needs to attach a Subscription to whoever pays, and
 * vendors pay. The obvious move — add "vendor" to TENANT_OWNER_ROLES so a
 * vendor carries a clubId — is WRONG, and this suite is what proves it.
 *
 * `clubId` drives tenantScope, and Tournament/Turf run with `enforce: true`.
 * Giving a vendor a clubId would make queryScope inject
 * `where({ clubId: <vendorUserId> })` into their reads, and since no tournament
 * is ever stamped with a vendor's id, a vendor would see ZERO tournaments.
 *
 * So the two concepts are kept apart:
 *   • clubId          → data isolation (unchanged; vendors stay cross-tenant)
 *   • billing subject → who a Subscription attaches to (clubs AND vendors)
 *
 * Test 1 is the regression guard: it passes BEFORE the Phase 0 change and must
 * keep passing after. If someone later "simplifies" this by adding vendor to
 * TENANT_OWNER_ROLES, Test 1 goes red.
 */
const mongoose = require("mongoose");
const { startTestApp, stopTestApp, clearDatabase } = require("./setup");
const {
  runWithTenant,
  contextForUser,
  getBillingSubjectId,
  TENANT_OWNER_ROLES,
} = require("../../utils/tenantContext");
const { mapLegacyRole } = require("../../middleware/rbacMiddleware");

const Tournament = require("../../src/modules/tournaments/models/Tournament");

const clubA = new mongoose.Types.ObjectId();
const clubB = new mongoose.Types.ObjectId();
const vendorId = new mongoose.Types.ObjectId();
const managerId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startTestApp();
});
afterAll(stopTestApp);

beforeEach(async () => {
  await clearDatabase();
  // Two tournaments owned by two different clubs. A vendor owns neither.
  await Tournament.collection.insertMany([
    { clubId: clubA, title: "Club A Open" },
    { clubId: clubB, title: "Club B Classic" },
  ]);
});

// ═══════════════════════════════════════════════════════════════
// Test 1 — THE REGRESSION GUARD
// ═══════════════════════════════════════════════════════════════

test("a vendor still sees every tournament — vendors are NOT data-scoped", async () => {
  const vendorCtx = contextForUser("vendor", vendorId);

  // The whole point: no clubId on the context, so tenantScope never fires.
  expect(vendorCtx.clubId).toBeUndefined();

  const seen = await runWithTenant(vendorCtx, async () =>
    Tournament.find({}).lean()
  );

  // Both clubs' tournaments are visible. If this drops to 0, someone has made
  // vendors a data tenant and broken the storefront's ability to browse.
  expect(seen).toHaveLength(2);
});

test("vendor is deliberately absent from TENANT_OWNER_ROLES", () => {
  // Documents the decision so a future edit is a conscious one, not a slip.
  expect(TENANT_OWNER_ROLES).not.toContain("vendor");
  expect(TENANT_OWNER_ROLES).toEqual(
    expect.arrayContaining(["ClubAdmin", "corporate_admin"])
  );
});

test("a club admin IS data-scoped — the contrast that makes Test 1 meaningful", async () => {
  const adminCtx = contextForUser("ClubAdmin", clubA);
  expect(adminCtx.clubId).toBe(String(clubA));

  const seen = await runWithTenant(adminCtx, async () =>
    Tournament.find({}).lean()
  );

  // Club A sees only its own. Proves enforce:true really is active on
  // Tournament, so Test 1's "2" is a real result and not a no-op.
  expect(seen).toHaveLength(1);
  expect(seen[0].title).toBe("Club A Open");
});

// ═══════════════════════════════════════════════════════════════
// Test 2 — the billing subject resolver
// ═══════════════════════════════════════════════════════════════

describe("getBillingSubjectId — who a Subscription attaches to", () => {
  test("a club admin bills against their own id", async () => {
    const id = await runWithTenant(contextForUser("ClubAdmin", clubA), () =>
      getBillingSubjectId()
    );
    expect(id).toBe(String(clubA));
  });

  test("a corporate admin bills against their own id", async () => {
    const id = await runWithTenant(
      contextForUser("corporate_admin", clubB),
      () => getBillingSubjectId()
    );
    expect(id).toBe(String(clubB));
  });

  test("a vendor bills against their own id — WITHOUT holding a clubId", async () => {
    const ctx = contextForUser("vendor", vendorId);
    expect(ctx.clubId).toBeUndefined(); // still not a data tenant

    const id = await runWithTenant(ctx, () => getBillingSubjectId());
    expect(id).toBe(String(vendorId)); // but IS a billing subject
  });

  test("a manager inherits the club's subscription", async () => {
    // Mirrors what authMiddleware.managerAuth builds for a Manager principal.
    const managerCtx = {
      clubId: String(clubA),
      principalId: String(managerId),
      principalType: "Manager",
    };
    const id = await runWithTenant(managerCtx, () => getBillingSubjectId());

    // The CLUB's id, not the manager's — so a manager gets what their club
    // bought, and never needs a subscription of their own.
    expect(id).toBe(String(clubA));
    expect(id).not.toBe(String(managerId));
  });

  test("a player has no billing subject", async () => {
    const id = await runWithTenant(
      contextForUser("Player", new mongoose.Types.ObjectId()),
      () => getBillingSubjectId()
    );
    expect(id).toBeNull();
  });

  test("no request context at all resolves to null, never throws", async () => {
    expect(await getBillingSubjectId()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 3 — RBAC role resolution
// ═══════════════════════════════════════════════════════════════

describe("mapLegacyRole", () => {
  test('"vendor" maps to the vendor role, not player', () => {
    // Before Phase 0 this fell through the map's default and returned "player",
    // so every vendor was evaluated against the player role's permissions.
    expect(mapLegacyRole("vendor")).toBe("vendor");
  });

  test("existing mappings are untouched", () => {
    expect(mapLegacyRole("ClubAdmin")).toBe("club_admin");
    expect(mapLegacyRole("corporate_admin")).toBe("club_admin");
    expect(mapLegacyRole("Manager")).toBe("manager");
    expect(mapLegacyRole("Player")).toBe("player");
    expect(mapLegacyRole("Referee")).toBe("referee");
  });

  test("an unknown role still falls back to player", () => {
    expect(mapLegacyRole("something_new")).toBe("player");
  });
});

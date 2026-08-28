"use strict";
/**
 * Per-request tenant context (Phase 1.1 multi-tenancy).
 *
 * Holds the resolved tenant for the current request in an AsyncLocalStorage
 * store so the tenantScope Mongoose plugin can auto-scope queries WITHOUT
 * threading clubId through every controller/service call.
 *
 *   ctx = { clubId?: string, principalType?: string, isSuperAdmin?: boolean }
 *
 * Tenant model (see audit): a "club"/tenant is a ClubAdmin or corporate_admin
 * User _id — the same convention Manager.clubId already uses. Club-staff
 * principals carry a clubId and get scoped:
 *   • ClubAdmin / corporate_admin → clubId = their own User _id
 *   • Manager                     → clubId = manager.clubId
 * Cross-tenant principals carry NO clubId and are never force-scoped:
 *   • Player, Trainer, Referee, Vendor, public
 * SuperAdmin sees everything (isSuperAdmin:true → scoping skipped).
 *
 * The context is established once, in the auth middleware, by wrapping next()
 * in runWithTenant(). Downstream middleware/handlers (and their awaits) inherit
 * the store automatically via async_hooks.
 */
const { AsyncLocalStorage } = require("async_hooks");
const mongoose = require("mongoose");

const als = new AsyncLocalStorage();

// User.role strings that own a club (the tenant root is their own User _id).
const TENANT_OWNER_ROLES = ["ClubAdmin", "corporate_admin"];

// User.role strings that hold a SUBSCRIPTION against their own id.
//
// Deliberately NOT the same list as TENANT_OWNER_ROLES. `vendor` appears here
// but must never appear there: TENANT_OWNER_ROLES drives clubId, clubId drives
// tenantScope, and Tournament/Turf run with `enforce: true`. Give a vendor a
// clubId and every read is filtered to `clubId = <vendorUserId>` — which no
// tournament ever carries — so the storefront would show zero tournaments.
//
// Billing subject and data tenant are two different questions that happen to
// share an answer for club owners. See getBillingSubjectId + the proof in
// tests/integration/vendorTenancy.test.js.
const SELF_BILLING_ROLES = ["ClubAdmin", "corporate_admin", "vendor"];

/** Run `fn` with the given tenant context active for the whole async chain. */
function runWithTenant(ctx, fn) {
  return als.run(ctx || {}, fn);
}

/** Current tenant context, or null if none was established for this request. */
function getTenant() {
  return als.getStore() || null;
}

/** Current tenant clubId, or null (cross-tenant / unauthenticated / superadmin). */
function getClubId() {
  const s = als.getStore();
  return s && s.clubId ? s.clubId : null;
}

/**
 * Aggregate scoping helper (Phase 1).
 *
 * The tenantScope plugin's pre-hooks cover find/update/delete/count but NOT
 * .aggregate(), so aggregation pipelines must scope the tenant EXPLICITLY by
 * prepending this stage:
 *
 *   const rows = await Model.aggregate([ ...tenantMatchStage(), ...stages ]);
 *
 * Returns:
 *  • [{ $match: { [field]: ObjectId(clubId) } }]  for a club-staff caller
 *  • []  for SuperAdmin / public / cross-tenant callers (no narrowing)
 *
 * Because it no-ops without a clubId context, the SAME call is safe on public
 * endpoints — spectators (no context) get the full result, club-staff get only
 * their tenant's slice. `field` defaults to "clubId"; pass another path for
 * collections whose tenant key has a different name.
 */
function tenantMatchStage(field = "clubId") {
  const s = als.getStore();
  if (!s || s.isSuperAdmin || !s.clubId) return [];
  return [{ $match: { [field]: new mongoose.Types.ObjectId(String(s.clubId)) } }];
}

/**
 * Build the tenant context for a User principal from its role + id.
 * Owner roles → scoped to their own id; everyone else → cross-tenant (no clubId).
 */
function contextForUser(role, userId) {
  // principalId is carried for EVERY principal, tenant or not. Billing needs to
  // identify a vendor, who has no clubId by design.
  const base = {
    principalType: role || "User",
    principalId: userId ? String(userId) : null,
  };
  if (TENANT_OWNER_ROLES.includes(role)) {
    return { ...base, clubId: String(userId) };
  }
  return base;
}

/**
 * The id a Subscription attaches to for the current request, or null.
 *
 *   • ClubAdmin / corporate_admin → their own id (== their clubId)
 *   • Manager / Substitute        → their CLUB's id, so staff inherit the plan
 *                                   the club bought and never hold one of their own
 *   • vendor                      → their own id, WITHOUT being a data tenant
 *   • everyone else               → null (players, trainers, referees, public)
 *
 * SuperAdmin returns null: SA bypasses permission checks entirely, so there is
 * nothing for a subscription to add.
 */
function getBillingSubject() {
  const s = als.getStore();
  if (!s || s.isSuperAdmin) return null;
  // A vendor bills as itself; club owners and their staff bill as the club.
  if (s.principalType === "vendor" && s.principalId) {
    return { id: String(s.principalId), type: "vendor" };
  }
  if (s.clubId) return { id: String(s.clubId), type: "club" };
  return null;
}

function getBillingSubjectId() {
  const s = als.getStore();
  if (!s || s.isSuperAdmin) return null;
  // Club staff (owner or manager) bill against the club.
  if (s.clubId) return String(s.clubId);
  // Self-billing non-tenants (vendor) bill against their own principal id.
  if (SELF_BILLING_ROLES.includes(s.principalType) && s.principalId) {
    return String(s.principalId);
  }
  return null;
}

module.exports = {
  als,
  runWithTenant,
  getTenant,
  getClubId,
  tenantMatchStage,
  contextForUser,
  getBillingSubject,
  getBillingSubjectId,
  TENANT_OWNER_ROLES,
  SELF_BILLING_ROLES,
};

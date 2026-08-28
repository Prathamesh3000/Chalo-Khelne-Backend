"use strict";
/**
 * Entitlements — the permissions a billing subject has BOUGHT, on top of the
 * permissions their role already carries.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EXPIRY IS DECIDED HERE, AT READ TIME
 * ─────────────────────────────────────────────────────────────────────────
 * The obvious design is a nightly job that finds lapsed subscriptions and
 * strips their permissions. That design has a silent, expensive failure mode:
 * if the job doesn't run — bad deploy, DB blip, missed schedule — every lapsed
 * customer keeps their paid features indefinitely and nothing reports it.
 *
 * Instead, `expiresAt: { $gt: now }` is part of the lookup. When the clock
 * passes it the query simply stops matching and the caller falls back to their
 * base role. There is no job to fail, and no state to repair.
 *
 * A cron may still EMAIL people about an upcoming expiry. It must never be
 * what enforces one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ISOLATION IS EXPLICIT
 * ─────────────────────────────────────────────────────────────────────────
 * Subscription deliberately carries no tenantScope plugin (see the model's
 * header comment — the plugin fails open for vendors). This module is
 * therefore the ONLY place that should query it for access decisions, and
 * every query here filters on subjectId.
 */
const Subscription = require("../src/modules/billing/models/Subscription");
const { als, getBillingSubjectId } = require("./tenantContext");

// A subscription grants access only in these states. "expired" and "cancelled"
// rows are kept for history and never grant anything.
const LIVE_STATUSES = ["trialing", "active"];

// ─────────────────────────────────────────────────────────────────────────
// TOURNAMENT-BOUNDARY GRACE (Trap 6)
// ─────────────────────────────────────────────────────────────────────────
// A subscription that lapses in the middle of an event must not wreck the
// event. Note what is NOT in this list: tournament:score and tournament:manage
// are in the FREE tier, so scoring, brackets and courts already survive any
// lapse without grace. (An earlier draft of the plan claimed a lapse killed
// live scoring — Phase 3's free-tier split made that untrue, and
// tests/integration/billingGrace.test.js keeps it that way.)
//
// What a lapse genuinely costs mid-event is the DESK: officials, walk-ins,
// fees, the entrant list, and printing the draw. Those get grace.
//
// Deliberately absent: tournament:create / bulk_register / anything that
// starts the NEXT event. Grace means "finish what you started", not "keep
// operating unpaid".
const GRACE_KEYS = [
  "referee:assign",
  "referee:read",
  "booking:approve",
  "player:view_all",
  "payment:read",
  "payment:approve",
  "tournament:export",
];

// Grace is also time-bounded. Without this, a club could keep one long-running
// "tournament" open forever and never pay again. 30 days covers any realistic
// single event.
const GRACE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Is this subject running a tournament right now?
 *
 * ⚠️  Tournament.startDate / endDate are declared as **String**, not Date
 * (src/modules/tournaments/models/Tournament.js). The codebase stores
 * "YYYY-MM-DD" — which is why it reconstructs times as
 * `new Date(`${startDate}T${startTime}`)` elsewhere.
 *
 * So this MUST compare strings. Passing a Date makes Mongoose cast it to
 * "Thu Aug 21 2026 …", which compares lexically against "2026-08-21" and
 * silently matches nothing — the failure is a quiet false, not an error.
 *
 * The bounds are chosen so both storage shapes behave:
 *   • bare  "2026-08-21"
 *   • full  "2026-08-21T00:00:00.000Z"
 * `startDate < tomorrow` is true for both (a full-ISO value for today still
 * sorts before tomorrow's bare date), and `endDate >= today` is true for both.
 */
async function hasTournamentInProgress(subjectId) {
  // Lazily required: utils must not pull a domain model at load time.
  const Tournament = require("../src/modules/tournaments/models/Tournament");

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);

  const running = await Tournament.findOne({
    clubId: subjectId,
    startDate: { $lt: tomorrow },
    endDate: { $gte: today },
  })
    .select("_id")
    .lean();
  return !!running;
}

// Per-request memo, parked on the AsyncLocalStorage store so it lives and dies
// with the request. A route may run more than one permission gate, and each
// would otherwise repeat the same lookup.
const CACHE_KEY = Symbol("entitlementCache");

function readCache(subjectId) {
  const store = als.getStore();
  if (!store) return undefined;
  const cached = store[CACHE_KEY];
  if (cached && cached.subjectId === String(subjectId)) return cached.value;
  return undefined;
}

function writeCache(subjectId, value) {
  const store = als.getStore();
  if (!store) return;
  store[CACHE_KEY] = { subjectId: String(subjectId), value };
}

/**
 * Drop the memo for the current request.
 *
 * Call this immediately after activating or changing a subscription inside a
 * request that then goes on to check permissions — otherwise the pre-purchase
 * answer would be reused and a customer who just paid would be denied.
 */
function clearEntitlementCache() {
  const store = als.getStore();
  if (store) delete store[CACHE_KEY];
}

/**
 * The live subscription for a subject, or null.
 *
 * If more than one live row somehow exists, the one expiring LAST wins. That
 * is deterministic rather than arbitrary, and it errs toward honouring what a
 * customer paid for. Renewal extends the existing row rather than inserting a
 * second one, so this should stay a one-row situation in practice.
 */
async function activeSubscription(subjectId) {
  if (!subjectId) return null;
  return Subscription.findOne({
    subjectId,
    status: { $in: LIVE_STATUSES },
    expiresAt: { $gt: new Date() },
  })
    .sort({ expiresAt: -1 })
    .lean();
}

/**
 * Permission keys this subject has bought and still holds. [] when there is no
 * subject (players, public) or no live subscription.
 *
 * Never throws: a billing lookup failing must not take down an access check
 * that the caller's ROLE would have allowed anyway. A failure degrades to
 * "no purchased extras", which is the safe direction — it can deny a paid
 * feature, never grant an unpaid one.
 */
async function grantedPermissions(subjectId) {
  if (!subjectId) return [];

  const cached = readCache(subjectId);
  if (cached !== undefined) return cached;

  let keys = [];
  try {
    // ONE query covers both cases: the newest period this subject has, live or
    // not. A subject who never subscribed gets null immediately — the common
    // free-tier path stays a single indexed lookup.
    const sub = await Subscription.findOne({ subjectId })
      .sort({ expiresAt: -1 })
      .select("grantedPermissions status expiresAt")
      .lean();

    const now = Date.now();

    if (!sub) {
      keys = [];
    } else if (
      LIVE_STATUSES.includes(sub.status) &&
      new Date(sub.expiresAt).getTime() > now
    ) {
      keys = sub.grantedPermissions || [];
    } else if (
      // Lapsed. Cancelling is voluntary, so it forfeits grace.
      sub.status !== "cancelled" &&
      new Date(sub.expiresAt).getTime() > now - GRACE_WINDOW_DAYS * DAY_MS &&
      (await hasTournamentInProgress(subjectId))
    ) {
      // Only the mid-event keys, and only ones they actually bought.
      const held = new Set(sub.grantedPermissions || []);
      keys = GRACE_KEYS.filter((k) => held.has(k));
      if (keys.length) {
        console.warn(
          `[entitlements] subject ${subjectId} is past expiry but has a tournament ` +
            `in progress — granting ${keys.length} mid-event key(s) until it ends.`
        );
      }
    } else {
      keys = [];
    }
  } catch (err) {
    console.error(
      `[entitlements] lookup failed for subject ${subjectId} — ` +
        `falling back to role-only permissions: ${err.message}`
    );
    keys = [];
  }

  writeCache(subjectId, keys);
  return keys;
}

/** Convenience: entitlements for whoever is making the current request. */
async function grantedPermissionsForRequest() {
  return grantedPermissions(getBillingSubjectId());
}

module.exports = {
  LIVE_STATUSES,
  GRACE_KEYS,
  GRACE_WINDOW_DAYS,
  hasTournamentInProgress,
  activeSubscription,
  grantedPermissions,
  grantedPermissionsForRequest,
  clearEntitlementCache,
};

const jwt = require("jsonwebtoken");
const Manager = require("../src/modules/identity/models/ClubManager").Manager;

const User = require("../src/modules/identity/models/User");
const Superadminmodel = require("../src/modules/identity/models/Superadminmodel");
const Substitute = require("../src/modules/identity/models/Substitute");
const { runWithTenant, contextForUser } = require("../utils/tenantContext");

// ═══════════════════════════════════════════════════════════════
// Suspension gate — shared across authenticate/managerAuth/allowUserOrManager.
// SuperAdmin is never suspendable, so this is only called for User/Manager
// documents. Returns true if the request was rejected (and the response was
// sent); caller must return immediately. Returns false if the user is active.
// ═══════════════════════════════════════════════════════════════
// §3.10.1 — the outcome used to be decided by "is it exactly 'suspended'?",
// with EVERY other non-active value falling through to "account rejected". A
// typo, a legacy value, or a future state such as "pending" locked the account
// out with a message that did not describe what had happened.
//
// Status is now matched explicitly. Only the two states the User schema
// declares (`suspended`, `rejected`) deny access; an unrecognised value is
// logged and treated as active, because failing an account out of the platform
// on a value nobody meant to be terminal is the worse error.
const DENIED_STATUSES = {
  suspended: {
    code: "ACCOUNT_SUSPENDED",
    message: "Your account has been suspended. Contact support.",
  },
  rejected: {
    code: "ACCOUNT_REJECTED",
    message: "Your account has been rejected. Contact support.",
  },
};

function rejectIfSuspended(account, res) {
  if (!account || !account.status || account.status === "active") return false;

  const denial = DENIED_STATUSES[account.status];
  if (!denial) {
    console.warn(
      `[AUTH] Unrecognised account status "${account.status}" on ${account._id} — ` +
        `treating as active. Add it to DENIED_STATUSES if it should deny access.`
    );
    return false;
  }

  return res.status(403).json({
    success: false,
    code: denial.code,
    message: denial.message,
    reason: account.suspensionReason || null,
  });
}

// Middleware to verify JWT token for managers
exports.managerAuth = async (req, res, next) => {
  // Check if the Authorization header is present
  const authHeader = req.header("Authorization");

  if (!authHeader) {
    return res
      .status(401)
      .json({ message: "Authorization denied. No token provided." });
  }

  // Ensure the token is properly formatted
  const token = authHeader.replace("Bearer ", "");

  try {
    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const manager = await Manager.findById(decoded.id).select(
      "_id status suspensionReason clubId"
    );

    if (!manager) {
      return res.status(401).json({ message: "Manager not found." });
    }

    if (rejectIfSuspended(manager, res)) return;

    // Store the decoded user in the request object for use in the next middleware
    req.user = decoded;
    // Tenant context: a Manager's tenant is its owning ClubAdmin (manager.clubId).
    const ctx = { clubId: manager.clubId ? String(manager.clubId) : null, principalType: "Manager" };
    return runWithTenant(ctx, () => next());
  } catch (error) {
    return res.status(401).json({ message: "Invalid token." });
  }
};

exports.authenticate = async (req, res, next) => {
  const authHeader = req.header("Authorization");

  if (!authHeader) {
    return res
      .status(401)
      .json({ message: "Authorization denied. No token provided." });
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const user = await User.findById(decoded.id).select(
      "_id role status suspensionReason isDeleted"
    );

    if (user) {
      // Guideline 5.1.1(v) — a user-deleted account survives as an anonymized
      // tombstone so other collections keep their references (see
      // services/accountDeletionService.js). It must never authenticate: the
      // access token issued before deletion stays cryptographically valid for
      // up to an hour, and this is what kills it immediately.
      if (user.isDeleted) {
        return res.status(401).json({ message: "Account deleted." });
      }
      if (rejectIfSuspended(user, res)) return;

      // §3.1 — the ROLE comes from the database record, not the token.
      //
      // This used to be `req.user = decoded`, which meant every downstream role
      // check (including requireRole, which reuses req.user when present)
      // trusted a claim minted when the token was issued. There is no token
      // version, no denylist and no refresh-token rotation, so a demoted
      // manager kept every manager-gated route working until their token
      // lapsed. Suspension was caught — that was read from the database on
      // every request — but a role change was not.
      //
      // The record is already loaded to check suspension, so `user.role` was
      // selected and then discarded. Using it is free.
      const effectiveRole = user.role || decoded.role;
      req.user = { ...decoded, role: effectiveRole };

      // Tenant context: owner roles (ClubAdmin/corporate_admin) scope to their own
      // id; players & other roles carry no clubId (cross-tenant) and aren't scoped.
      return runWithTenant(contextForUser(effectiveRole, decoded.id), () => next());
    }

    // Substitute — a temporary stand-in for a coach. Same active+accepted gate
    // as allowUserOrManager, so the substitute can hit any "authenticate"-gated
    // route (notifications, etc.) while their access is live.
    const substitute = await Substitute.findById(decoded.id).select(
      "_id active status clubId coachId"
    );
    if (substitute) {
      if (!substitute.active || substitute.status !== "accepted") {
        return res.status(403).json({ message: "Your substitute access has ended." });
      }
      req.user = decoded;
      req.userRole = "Substitute";
      const ctx = {
        clubId: substitute.clubId ? String(substitute.clubId) : null,
        principalType: "Substitute",
      };
      return runWithTenant(ctx, () => next());
    }

    return res.status(401).json({ message: "User not found." });
  } catch (error) {
    // Distinguish expiry from a malformed/forged token, as rbacMiddleware does.
    // Collapsing both into "Invalid token." sent us hunting a secret mismatch
    // when the real cause was a client shipping the string "Bearer null".
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired." });
    }
    return res.status(401).json({ message: "Invalid token." });
  }
};

exports.allowUserOrManager = async (req, res, next) => {
  const authHeader = req.header("Authorization");

  if (!authHeader) {
    return res.status(401).json({ message: "Authorization denied. No token provided." });
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const id = decoded.id || decoded.userId; // Support both token formats

    // SuperAdmin — never suspendable, allow directly. Sees all tenants.
    if (decoded.role === "superadmin") {
      req.user = { _id: id, role: "superadmin", email: decoded.email };
      req.userRole = "SuperAdmin";
      req.isSuperAdmin = true;
      return runWithTenant({ isSuperAdmin: true, principalType: "SuperAdmin" }, () => next());
    }

    let user = await User.findById(id);
    if (user) {
      // Deleted-account tombstone — see authenticate() above.
      if (user.isDeleted) {
        return res.status(401).json({ message: "Account deleted." });
      }
      if (rejectIfSuspended(user, res)) return;
      req.user = user;
      req.userRole = "User";
      return runWithTenant(contextForUser(user.role, user._id), () => next());
    }

    const manager = await Manager.findById(id);
    if (manager) {
      if (rejectIfSuspended(manager, res)) return;
      req.user = manager;
      req.userRole = "Manager";
      const ctx = { clubId: manager.clubId ? String(manager.clubId) : null, principalType: "Manager" };
      return runWithTenant(ctx, () => next());
    }

    // Substitute — a temporary stand-in for a coach; valid only while active.
    const substitute = await Substitute.findById(id);
    if (substitute) {
      if (!substitute.active || substitute.status !== "accepted") {
        return res.status(403).json({ message: "Your substitute access has ended." });
      }
      req.user = substitute;
      req.userRole = "Substitute";
      const ctx = { clubId: substitute.clubId ? String(substitute.clubId) : null, principalType: "Substitute" };
      return runWithTenant(ctx, () => next());
    }

    return res.status(401).json({ message: "User, Manager, or Substitute not found." });
  } catch (err) {
    return res.status(401).json({ message: "Invalid token." });
  }
};

/**
 * requireSuperAdmin — gate for the SuperAdmin control plane (RBAC, user
 * approval/role changes, sport/coupon admin, etc.).
 *
 * Superadmin tokens come in two shapes:
 *   • POST /login           → { email, role: "superadmin", userId }   (has role)
 *   • POST /superadminlogin → { email, userId }                       (NO role)
 * Because one shape carries no role claim, we don't trust the role string —
 * we resolve the id (userId|id) and confirm it exists in the Superadmin
 * collection. A regular User/Manager _id will not be found there, so this
 * is a hard membership check, not a guessable claim.
 *
 * SuperAdmin accounts are NEVER suspendable — no status check here.
 */
exports.requireSuperAdmin = async (req, res, next) => {
  const authHeader = req.header("Authorization");
  if (!authHeader) {
    return res.status(401).json({ success: false, message: "Authorization denied. No token provided." });
  }
  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const id = decoded.userId || decoded.id;
    if (!id) {
      return res.status(403).json({ success: false, message: "Superadmin access required" });
    }
    const sa = await Superadminmodel.findById(id).select("_id").lean();
    if (!sa) {
      return res.status(403).json({ success: false, message: "Superadmin access required" });
    }
    req.user = decoded;
    req.userRole = "SuperAdmin";
    req.isSuperAdmin = true;
    req.superadminId = String(id);
    return runWithTenant({ isSuperAdmin: true, principalType: "SuperAdmin" }, () => next());
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid token." });
  }
};

/**
 * requireRole(...allowed) — general role gate. Reuses req.user if a prior
 * auth middleware already ran, otherwise decodes the token itself, so it can
 * stand alone on a route. Roles are matched exactly as stored on the token
 * ("Manager", "ClubAdmin", "corporate_admin", "superadmin", ...). A roleless
 * /superadminlogin token is resolved to "superadmin" via the collection.
 *
 *   router.post("/x", requireRole("corporate_admin", "superadmin"), handler)
 */
exports.requireRole = (...allowed) => async (req, res, next) => {
  // §3.10.2 — the token is ALWAYS re-verified here.
  //
  // This used to reuse `req.user` whenever it was already set, without
  // re-verifying it. That is correct today because every caller runs an auth
  // middleware first — but the function is documented as being able to stand
  // alone on a route, and in that configuration it would accept whatever a
  // previous middleware happened to attach. Verifying the header costs one
  // HMAC and removes the assumption entirely.
  const authHeader = req.header("Authorization");
  if (!authHeader) {
    return res.status(401).json({ success: false, message: "Authorization denied. No token provided." });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.replace("Bearer ", ""), process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid token." });
  }

  // §3.1 — prefer the role an upstream auth middleware resolved from the
  // DATABASE over the token's claim. authenticate() sets req.user.role from the
  // User record precisely so a demotion takes effect immediately.
  let role =
    (req.user && typeof req.user === "object" && req.user.role) || decoded.role;
  // /superadminlogin tokens carry no role — resolve membership from the collection.
  if (!role) {
    const id = decoded.userId || decoded.id;
    if (id) {
      try {
        const sa = await Superadminmodel.findById(id).select("_id").lean();
        if (sa) role = "superadmin";
      } catch (_) { /* fall through to 403 */ }
    }
  }
  // SuperAdmin bypasses all role gates — full-application access by design.
  // Even if the caller forgot to list "superadmin", SA always passes.
  if (role === "superadmin") {
    req.user = decoded;
    req.userRole = "superadmin";
    req.isSuperAdmin = true;
    return next();
  }
  if (!role || !allowed.includes(role)) {
    return res.status(403).json({ success: false, message: "Forbidden: insufficient role" });
  }
  req.user = decoded;
  req.userRole = role;
  return next();
};

/**
 * Sign in with Apple — identity-token verification and token revocation.
 *
 * App Store Guideline 4.8 requires Sign in with Apple wherever a third-party
 * login (Google, here) is offered. Guideline 5.1.1(v) additionally requires
 * that deleting an account revokes the Apple token.
 *
 * ── Why verify locally instead of calling an Apple "verify" endpoint ─────────
 * Apple has no tokeninfo endpoint (unlike Google). The identity token is a
 * plain RS256 JWS: the correct verification is to fetch Apple's public JWKS
 * once, cache it, and check the signature + iss/aud/exp ourselves. The client's
 * body is NEVER trusted — the email and the user id come from the verified
 * claims.
 *
 * ── Dependencies ────────────────────────────────────────────────────────────
 * No new package. `jsonwebtoken` (already a direct dependency) verifies the
 * signature; Node's built-in `crypto` converts Apple's JWK into a public key
 * via `createPublicKey({ format: "jwk" })`. That is why there is no jose /
 * jwks-rsa / apple-signin-auth import here.
 */
"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = process.env.APPLE_JWKS_URL || "https://appleid.apple.com/auth/keys";
const APPLE_TOKEN_URL = process.env.APPLE_TOKEN_URL || "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = process.env.APPLE_REVOKE_URL || "https://appleid.apple.com/auth/revoke";

// The iOS bundle id is the `aud` of a token minted by expo-apple-authentication.
// Comma-separated so a web Service ID can be added later without a code change.
const DEFAULT_APPLE_CLIENT_ID = "com.chalokhelnesport.client";

function appleAudiences() {
  return (process.env.APPLE_CLIENT_ID || DEFAULT_APPLE_CLIENT_ID)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── JWKS cache ──────────────────────────────────────────────────────────────
// Apple's keys rotate rarely but DO rotate. Cached in memory with a TTL so a
// login costs zero outbound requests; a `kid` miss forces one refresh (see
// verifyAppleIdentityToken) so a rotation doesn't lock every iOS user out for
// the length of the TTL.
const JWKS_TTL_MS = Number(process.env.APPLE_JWKS_TTL_MS || 6 * 60 * 60 * 1000); // 6h
let jwksCache = { keys: null, fetchedAt: 0 };

/** Test/ops hook — drops the cached keys. */
function resetJwksCache() {
  jwksCache = { keys: null, fetchedAt: 0 };
}

async function fetchAppleKeys() {
  const res = await fetch(APPLE_JWKS_URL);
  if (!res.ok) throw new Error(`Apple JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("Apple JWKS response contained no keys");
  }
  return body.keys;
}

async function getAppleKeys({ forceRefresh = false } = {}) {
  const fresh = jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && !forceRefresh) return jwksCache.keys;
  try {
    const keys = await fetchAppleKeys();
    jwksCache = { keys, fetchedAt: Date.now() };
    return keys;
  } catch (err) {
    // A transient Apple outage should not take logins down while we still hold
    // usable (if stale) keys — the signature check is what provides security,
    // not the freshness of the cache.
    if (jwksCache.keys) {
      console.warn("[APPLE] JWKS refresh failed, using cached keys:", err.message);
      return jwksCache.keys;
    }
    throw err;
  }
}

function jwkToPublicKey(jwk) {
  // Node >= 16: JWK is a first-class key input format, so no manual
  // modulus/exponent DER assembly (the usual source of bugs here).
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Verify an Apple identity token (the JWT from expo-apple-authentication).
 *
 * Checks: RS256 signature against Apple's JWKS, iss === appleid.apple.com,
 * aud === our bundle id, and expiry (jsonwebtoken enforces exp/nbf).
 *
 * @returns verified claims: { sub, email, email_verified, is_private_email, ... }
 * @throws  Error on ANY failure — callers must treat a throw as "unauthenticated".
 */
async function verifyAppleIdentityToken(identityToken) {
  if (!identityToken || typeof identityToken !== "string") {
    throw new Error("identityToken is missing");
  }

  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.payload) {
    throw new Error("identityToken is not a decodable JWT");
  }
  // Pin the algorithm before we go anywhere near a key: refuse "none" and
  // refuse an HS* token that would otherwise be verified with the public key
  // as an HMAC secret (the classic algorithm-confusion attack).
  if (decoded.header.alg !== "RS256") {
    throw new Error(`unexpected identityToken alg: ${decoded.header.alg}`);
  }
  const kid = decoded.header.kid;
  if (!kid) throw new Error("identityToken header has no kid");

  const findKey = (keys) => keys.find((k) => k.kid === kid && (!k.alg || k.alg === "RS256"));

  let keys = await getAppleKeys();
  let jwk = findKey(keys);
  if (!jwk) {
    // Unknown kid → Apple may have rotated. One forced refresh, then give up.
    keys = await getAppleKeys({ forceRefresh: true });
    jwk = findKey(keys);
  }
  if (!jwk) throw new Error(`no Apple public key for kid ${kid}`);

  const claims = jwt.verify(identityToken, jwkToPublicKey(jwk), {
    algorithms: ["RS256"],
    issuer: APPLE_ISSUER,
    audience: appleAudiences(),
  });

  if (!claims || !claims.sub) throw new Error("verified token has no sub claim");
  return claims;
}

// ── Client secret / revocation ──────────────────────────────────────────────
// Apple's /auth/token and /auth/revoke endpoints authenticate the APP with a
// short-lived ES256 JWT ("client secret") signed with a .p8 key downloaded from
// the Apple Developer portal.
//
// ⚠️ MUST BE CONFIGURED BEFORE RELEASE. Until APPLE_TEAM_ID / APPLE_KEY_ID /
// APPLE_PRIVATE_KEY are set, account deletion still deletes the account (as
// Guideline 5.1.1(v) requires) but cannot revoke the Apple token, which Apple
// also requires. The .p8 key has not been generated yet.

function appleRevocationConfigured() {
  return Boolean(
    process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY
  );
}

function buildAppleClientSecret() {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  // Render/Heroku-style env vars can't hold real newlines — accept the common
  // "\n"-escaped form as well as a genuine multi-line value.
  const privateKey = String(process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const clientId = appleAudiences()[0];

  return jwt.sign({}, privateKey, {
    algorithm: "ES256",
    keyid: keyId,
    issuer: teamId,
    audience: APPLE_ISSUER,
    subject: clientId,
    expiresIn: "5m", // Apple allows up to 6 months; short is strictly better
  });
}

/**
 * Exchange an authorizationCode for Apple tokens. Used at apple-login so a
 * refresh token is on hand at deletion time (Apple's /auth/revoke needs an
 * actual token; the identity token is not one).
 * @returns {Promise<{refresh_token?:string}|null>} null when unconfigured/failed.
 */
async function exchangeAppleAuthorizationCode(authorizationCode) {
  if (!authorizationCode || !appleRevocationConfigured()) return null;
  try {
    const body = new URLSearchParams({
      client_id: appleAudiences()[0],
      client_secret: buildAppleClientSecret(),
      code: authorizationCode,
      grant_type: "authorization_code",
    });
    const res = await fetch(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      console.warn("[APPLE] code exchange failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    return await res.json();
  } catch (err) {
    // Non-fatal: a failed exchange must never block a valid sign-in.
    console.warn("[APPLE] code exchange threw:", err.message);
    return null;
  }
}

/**
 * Revoke an Apple token (refresh_token preferred, access_token accepted).
 * Never throws: deletion must proceed even if Apple is unreachable.
 * @returns {Promise<{revoked:boolean, reason?:string}>}
 */
async function revokeAppleToken(token, tokenTypeHint = "refresh_token") {
  if (!appleRevocationConfigured()) {
    console.warn(
      "[APPLE] token revocation SKIPPED — APPLE_TEAM_ID / APPLE_KEY_ID / " +
        "APPLE_PRIVATE_KEY are not configured. Apple requires revocation on " +
        "account deletion (Guideline 5.1.1(v)); configure these before release."
    );
    return { revoked: false, reason: "not_configured" };
  }
  if (!token) {
    console.warn(
      "[APPLE] token revocation SKIPPED — no Apple refresh token stored for " +
        "this account. The client should send `appleAuthorizationCode` with " +
        "the delete request, or apple-login should capture `authorizationCode`."
    );
    return { revoked: false, reason: "no_token" };
  }
  try {
    const body = new URLSearchParams({
      client_id: appleAudiences()[0],
      client_secret: buildAppleClientSecret(),
      token,
      token_type_hint: tokenTypeHint,
    });
    const res = await fetch(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn("[APPLE] revoke failed:", res.status, detail);
      return { revoked: false, reason: `http_${res.status}` };
    }
    return { revoked: true };
  } catch (err) {
    console.warn("[APPLE] revoke threw:", err.message);
    return { revoked: false, reason: "network_error" };
  }
}

module.exports = {
  APPLE_ISSUER,
  APPLE_JWKS_URL,
  appleAudiences,
  appleRevocationConfigured,
  buildAppleClientSecret,
  exchangeAppleAuthorizationCode,
  getAppleKeys,
  resetJwksCache,
  revokeAppleToken,
  verifyAppleIdentityToken,
};

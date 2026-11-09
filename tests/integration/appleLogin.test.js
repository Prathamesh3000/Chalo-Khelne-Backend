"use strict";
/**
 * Sign in with Apple — POST /api/apple-login (App Store Guideline 4.8).
 *
 * What these tests pin:
 *   • the identity token is verified CRYPTOGRAPHICALLY — a garbage token, a
 *     token forged with an attacker's own RSA key, a wrong `aud`, a wrong
 *     `iss` and an expired token are all rejected. This is the security case:
 *     if any of these passes, anyone can log in as anyone;
 *   • the client's body email is never trusted — only the verified claim;
 *   • first authorization persists name + email (Apple sends them once only);
 *   • a later sign-in carries NO name/email and must not blank the stored ones;
 *   • an existing account with the same verified email is LINKED (appleId
 *     attached), never duplicated;
 *   • "Hide My Email" (@privaterelay.appleid.com) is accepted;
 *   • the response shape is identical to /google-login (the mobile app reuses
 *     its googleLogin handling).
 *
 * Apple's JWKS endpoint is stubbed: the suite generates its own RSA keypair,
 * publishes it as a JWK, and signs tokens with it — so the real signature
 * path runs end to end without touching the network.
 */
const crypto = require("crypto");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { startTestApp, stopTestApp, clearDatabase } = require("./setup");
const User = require("../../src/modules/identity/models/User");
const appleAuth = require("../../utils/appleAuth");

const BUNDLE_ID = "com.chalokhelnesport.client";
const APPLE_ISS = "https://appleid.apple.com";

// ── Apple's keypair (ours, for the test) and an attacker's ──
const KID = "test-apple-kid-1";
const apple = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwkFor(publicKey, kid) {
  return {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
}
const APPLE_JWKS = { keys: [jwkFor(apple.publicKey, KID)] };

/** Sign an Apple-shaped identity token. */
function identityToken(claims = {}, { key = apple.privateKey, kid = KID } = {}) {
  const { expiresIn = "10m", ...rest } = claims;
  return jwt.sign(
    {
      iss: APPLE_ISS,
      aud: BUNDLE_ID,
      sub: "000123.abcdef.0001",
      ...rest,
    },
    key,
    { algorithm: "RS256", keyid: kid, expiresIn },
  );
}

let app;
let fetchCalls;

beforeAll(async () => {
  process.env.APPLE_CLIENT_ID = BUNDLE_ID;
  app = await startTestApp();
});
afterAll(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDatabase();
  appleAuth.resetJwksCache();
  fetchCalls = 0;
  global.fetch = jest.fn(async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => APPLE_JWKS };
  });
});

const post = (body) => request(app).post("/api/apple-login").send(body);

describe("POST /api/apple-login — token verification (security)", () => {
  it("rejects a request with no identityToken (400)", async () => {
    const res = await post({ fullName: "Mallory", email: "m@x.com", platform: "ios" });
    expect(res.status).toBe(400);
    expect(await User.countDocuments()).toBe(0);
  });

  it("rejects a garbage token (401)", async () => {
    const res = await post({ identityToken: "not-a-jwt-at-all", platform: "ios" });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(await User.countDocuments()).toBe(0);
  });

  it("rejects a token forged with somebody else's RSA key (401)", async () => {
    // Correct iss/aud/kid, valid RS256 structure — only the signature is wrong.
    const forged = identityToken(
      { sub: "000123.forged.0001", email: "victim@example.com" },
      { key: attacker.privateKey, kid: KID },
    );
    const res = await post({ identityToken: forged, platform: "ios" });
    expect(res.status).toBe(401);
    expect(await User.countDocuments()).toBe(0);
  });

  it("rejects an alg=none / unsigned token (401)", async () => {
    const unsigned =
      Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url") +
      "." +
      Buffer.from(
        JSON.stringify({ iss: APPLE_ISS, aud: BUNDLE_ID, sub: "x", exp: 9999999999 }),
      ).toString("base64url") +
      ".";
    const res = await post({ identityToken: unsigned, platform: "ios" });
    expect(res.status).toBe(401);
  });

  it("rejects a token for another app's audience (401)", async () => {
    const res = await post({
      identityToken: identityToken({ aud: "com.someone.else" }),
      platform: "ios",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token from the wrong issuer (401)", async () => {
    const res = await post({
      identityToken: identityToken({ iss: "https://evil.example.com" }),
      platform: "ios",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token (401)", async () => {
    const res = await post({
      identityToken: identityToken({ expiresIn: "-60s", email: "a@b.com" }),
      platform: "ios",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a token whose kid is not in Apple's JWKS (401)", async () => {
    const res = await post({
      identityToken: identityToken({}, { kid: "unknown-kid" }),
      platform: "ios",
    });
    expect(res.status).toBe(401);
  });

  it("caches the JWKS instead of fetching it per request", async () => {
    const t = () => identityToken({ sub: "000123.cache.1", email: "cache@test.local" });
    await post({ identityToken: t(), platform: "ios" });
    const after1 = fetchCalls;
    await post({ identityToken: t(), platform: "ios" });
    await post({ identityToken: t(), platform: "ios" });
    expect(after1).toBe(1);
    expect(fetchCalls).toBe(1);
  });
});

describe("POST /api/apple-login — find or create", () => {
  it("first sign-in creates the user with Apple's name and email", async () => {
    const res = await post({
      identityToken: identityToken({
        sub: "000123.first.0001",
        email: "Rohan.First@Example.com",
        email_verified: "true",
      }),
      fullName: "Rohan First",
      email: "Rohan.First@Example.com",
      platform: "ios",
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");

    // Same response shape as /google-login — the app reuses that handler.
    // (`profilePicture` is emitted by both endpoints but, being undefined for a
    // brand-new Apple account, is dropped by JSON serialization exactly as it
    // is on the Google path — so it is allowed, not required.)
    expect(Object.keys(res.body).sort()).toEqual(["refreshToken", "token", "user"]);
    const GOOGLE_USER_KEYS = [
      "_id",
      "email",
      "id",
      "isApproved",
      "mobile",
      "name",
      "needsMobileUpdate",
      "profilePicture",
      "requiresDob",
      "role",
    ];
    expect(Object.keys(res.body.user).sort()).toEqual(
      GOOGLE_USER_KEYS.filter((k) => k !== "profilePicture").sort(),
    );
    for (const k of Object.keys(res.body.user)) expect(GOOGLE_USER_KEYS).toContain(k);
    expect(res.body.user.name).toBe("Rohan First");
    expect(res.body.user.email).toBe("rohan.first@example.com");
    expect(res.body.user.role).toBe("Player");
    // Apple returns no birthday → the account is created DOB-locked, exactly
    // as a Google account is.
    expect(res.body.user.requiresDob).toBe(true);
    expect(res.body.user.needsMobileUpdate).toBe(true);

    const stored = await User.findOne({ appleId: "000123.first.0001" });
    expect(stored).toBeTruthy();
    expect(stored.name).toBe("Rohan First");
    expect(stored.email).toBe("rohan.first@example.com");
    expect(stored.authProvider).toBe("apple");
    expect(stored.emailVerified).toBe(true);
  });

  it("uses the token's email claim, not the body's", async () => {
    const res = await post({
      identityToken: identityToken({
        sub: "000123.spoof.0001",
        email: "real@example.com",
      }),
      fullName: "Spoofer",
      email: "admin@chalokhelne.com", // attacker-supplied, must be ignored
      platform: "ios",
    });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("real@example.com");
    expect(await User.countDocuments({ email: "admin@chalokhelne.com" })).toBe(0);
  });

  it("accepts a Hide-My-Email private relay address", async () => {
    const res = await post({
      identityToken: identityToken({
        sub: "000123.relay.0001",
        email: "abc123xyz@privaterelay.appleid.com",
        is_private_email: "true",
      }),
      fullName: "Private Person",
      platform: "ios",
    });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("abc123xyz@privaterelay.appleid.com");
    const stored = await User.findOne({ appleId: "000123.relay.0001" });
    expect(stored.email).toBe("abc123xyz@privaterelay.appleid.com");
  });

  it("a second sign-in with no name/email still logs in and does NOT blank the stored values", async () => {
    const sub = "000123.second.0001";

    const first = await post({
      identityToken: identityToken({ sub, email: "keep.me@example.com" }),
      fullName: "Keep Me",
      email: "keep.me@example.com",
      platform: "ios",
    });
    expect(first.status).toBe(200);

    // Apple's quirk: on every later authorization there is no name and no
    // email claim, and the client sends none either.
    const second = await post({
      identityToken: identityToken({ sub }), // no email claim at all
      platform: "ios",
    });

    expect(second.status).toBe(200);
    expect(second.body.user.name).toBe("Keep Me");
    expect(second.body.user.email).toBe("keep.me@example.com");
    expect(typeof second.body.token).toBe("string");

    const stored = await User.findOne({ appleId: sub });
    expect(stored.name).toBe("Keep Me");
    expect(stored.email).toBe("keep.me@example.com");
    // One account, not two.
    expect(await User.countDocuments()).toBe(1);
  });

  it("an empty fullName on a later sign-in does not overwrite the stored name", async () => {
    const sub = "000123.blank.0001";
    await post({
      identityToken: identityToken({ sub, email: "blank@example.com" }),
      fullName: "Real Name",
      platform: "ios",
    });
    const res = await post({
      identityToken: identityToken({ sub }),
      fullName: "", // expo sends "" / null once the first authorization is done
      email: null,
      platform: "ios",
    });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Real Name");
    expect((await User.findOne({ appleId: sub })).name).toBe("Real Name");
  });

  it("links appleId onto an existing account with the same verified email instead of duplicating", async () => {
    const existing = await User.create({
      name: "Existing Google User",
      email: "shared@example.com",
      password: "whatever",
      role: "Player",
      mobile: "9876543210",
      dateOfBirth: new Date("1994-05-05"),
      sex: "male",
      isApproved: true,
      authProvider: "google",
      googleId: "google-sub-123",
    });

    const res = await post({
      identityToken: identityToken({
        sub: "000123.link.0001",
        email: "shared@example.com",
      }),
      fullName: "Apple Name",
      platform: "ios",
    });

    expect(res.status).toBe(200);
    expect(String(res.body.user.id)).toBe(String(existing._id));
    expect(res.body.user.name).toBe("Existing Google User"); // not overwritten

    expect(await User.countDocuments({ email: "shared@example.com" })).toBe(1);
    const linked = await User.findById(existing._id);
    expect(linked.appleId).toBe("000123.link.0001");
    expect(linked.googleId).toBe("google-sub-123"); // google login still works
    expect(linked.authProvider).toBe("google"); // original provider preserved
  });

  it("a suspended account cannot sign in with Apple (403)", async () => {
    await User.create({
      name: "Suspended",
      email: "susp@example.com",
      password: "x",
      role: "Player",
      mobile: "9000000001",
      dateOfBirth: new Date("1990-01-01"),
      sex: "male",
      isApproved: true,
      appleId: "000123.susp.0001",
      status: "suspended",
    });
    const res = await post({
      identityToken: identityToken({ sub: "000123.susp.0001" }),
      platform: "ios",
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
  });
});

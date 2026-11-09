"use strict";
/**
 * Account deletion — DELETE /api/account (App Store Guideline 5.1.1(v)).
 *
 * What these tests pin:
 *   • an unauthenticated call is rejected;
 *   • the confirmation signal is mandatory (a stray call can't nuke an account);
 *   • a user can delete their OWN account, every personal field is overwritten,
 *     and afterwards they can neither log in nor use their old access token;
 *   • one user CANNOT delete another's — the id comes from the verified token,
 *     so a userId in the body is simply ignored;
 *   • references behave as designed (services/accountDeletionService.js):
 *       – bookings are RETAINED with the registrant's contact details scrubbed
 *         (a club's booking history must not be corrupted by a player leaving),
 *       – purely personal records (posts, refresh tokens, device tokens) are
 *         PURGED,
 *       – the id is pulled out of other users' follower lists;
 *   • deletion is irreversible: the email is freed for re-registration and the
 *     tombstone can never authenticate again.
 */
const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const { startTestApp, stopTestApp, clearDatabase } = require("./setup");
const User = require("../../src/modules/identity/models/User");
const Booking = require("../../src/modules/tournaments/models/BookingModel");
const Post = require("../../src/modules/social/models/Post");
const RefreshToken = require("../../src/modules/identity/models/RefreshToken");
const DeviceToken = require("../../src/modules/identity/models/DeviceToken");

let app;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await stopTestApp();
});
beforeEach(clearDatabase);

const PASSWORD = "CorrectHorse1!";

const tokenFor = (user) =>
  jwt.sign(
    { id: String(user._id), role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  return User.create({
    name: `Player ${seq}`,
    email: `player${seq}@test.local`,
    password: PASSWORD, // hashed by the pre-save hook
    role: "Player",
    mobile: `98000000${String(seq).padStart(2, "0")}`,
    dateOfBirth: new Date("1995-03-03"),
    sex: "male",
    isApproved: true,
    address: "12 Example Road, Pune",
    bio: "I play a lot of table tennis",
    emergencyContact: "9999988888",
    identityType: "pan-card",
    identityId: "ABCDE1234F",
    expoPushToken: "ExponentPushToken[xxxx]",
    ...overrides,
  });
}

const del = (token, body) => {
  const req = request(app).delete("/api/account");
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send(body);
};

describe("DELETE /api/account — authorization", () => {
  it("rejects an unauthenticated call (401)", async () => {
    const user = await makeUser();
    const res = await request(app).delete("/api/account").send({ confirm: "DELETE" });
    expect(res.status).toBe(401);
    expect((await User.findById(user._id)).isDeleted).toBe(false);
  });

  it("rejects a garbage bearer token (401)", async () => {
    const user = await makeUser();
    const res = await del("not-a-real-token", { confirm: "DELETE" });
    expect(res.status).toBe(401);
    expect((await User.findById(user._id)).isDeleted).toBe(false);
  });

  it("requires the confirmation signal (400)", async () => {
    const user = await makeUser();
    const noBody = await del(tokenFor(user), {});
    expect(noBody.status).toBe(400);

    const wrong = await del(tokenFor(user), { confirm: "delete" });
    expect(wrong.status).toBe(400);

    expect((await User.findById(user._id)).isDeleted).toBe(false);
    expect((await User.findById(user._id)).name).toBe(user.name);
  });

  it("one user cannot delete another's account — the body's userId is ignored", async () => {
    const attacker = await makeUser({ name: "Attacker" });
    const victim = await makeUser({ name: "Victim" });

    const res = await del(tokenFor(attacker), {
      confirm: "DELETE",
      // Every shape an attacker might try. All must be ignored: the id comes
      // from the verified token only.
      userId: String(victim._id),
      id: String(victim._id),
      _id: String(victim._id),
      email: victim.email,
    });
    expect(res.status).toBe(200);

    const victimAfter = await User.findById(victim._id);
    expect(victimAfter.isDeleted).toBe(false);
    expect(victimAfter.name).toBe("Victim");
    expect(victimAfter.email).toBe(victim.email);

    // The caller's OWN account is the one that went.
    expect((await User.findById(attacker._id)).isDeleted).toBe(true);
  });

  it("a route param cannot be used to target another account", async () => {
    const attacker = await makeUser();
    const victim = await makeUser();
    // No :id variant of the route exists — assert it stays that way.
    const res = await request(app)
      .delete(`/api/account/${victim._id}`)
      .set("Authorization", `Bearer ${tokenFor(attacker)}`)
      .send({ confirm: "DELETE" });
    expect(res.status).toBe(404);
    expect((await User.findById(victim._id)).isDeleted).toBe(false);
  });
});

describe("DELETE /api/account — deletion semantics", () => {
  it("deletes the caller's own account and scrubs every personal field", async () => {
    const user = await makeUser({ name: "Deepa Kulkarni" });
    const res = await del(tokenFor(user), { confirm: "DELETE" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await User.findById(user._id).select("+appleRefreshToken");
    // The row survives as a tombstone (so 90+ collections keep their refs)…
    expect(after).toBeTruthy();
    expect(after.isDeleted).toBe(true);
    expect(after.deletedAt).toBeInstanceOf(Date);
    expect(after.isActive).toBe(false);
    // …with nothing personal left on it.
    expect(after.name).toBe("Deleted User");
    expect(after.email).toBe(`deleted-${user._id}@deleted.invalid`);
    expect(after.mobile).toBe("deleted");
    expect(after.bio).toBe("");
    expect(after.address).toBe("");
    expect(after.emergencyContact).toBe("");
    expect(after.identityId).toBeUndefined();
    expect(after.identityType).toBeUndefined();
    expect(after.dateOfBirth).toBeUndefined();
    expect(after.sex).toBeUndefined();
    expect(after.expoPushToken).toBeNull();
    expect(after.profileImage).toBeNull();
    expect(after.certificates).toHaveLength(0);
    // The password is overwritten with a random value nobody holds.
    expect(after.password).not.toBe(user.password);
  });

  it("is irreversible: the user cannot log in afterwards", async () => {
    const user = await makeUser();
    const email = user.email;

    const before = await request(app).post("/api/login").send({ email, password: PASSWORD });
    expect(before.status).toBe(200);

    expect((await del(tokenFor(user), { confirm: "DELETE" })).status).toBe(200);

    const after = await request(app).post("/api/login").send({ email, password: PASSWORD });
    expect(after.status).toBe(404);
    expect(after.body.token).toBeUndefined();
  });

  it("invalidates the access token that was used to delete", async () => {
    const user = await makeUser();
    const token = tokenFor(user);
    expect((await del(token, { confirm: "DELETE" })).status).toBe(200);

    // The JWT is still cryptographically valid for another hour; the auth
    // middleware must refuse it because the account is deleted.
    const again = await del(token, { confirm: "DELETE" });
    expect(again.status).toBe(401);
  });

  it("frees the email address for re-registration", async () => {
    const user = await makeUser();
    const email = user.email;
    await del(tokenFor(user), { confirm: "DELETE" });
    expect(await User.countDocuments({ email })).toBe(0);
  });

  it("is idempotent at the service level (already-deleted account)", async () => {
    const { deleteUserAccount } = require("../../services/accountDeletionService");
    const user = await makeUser();
    expect((await deleteUserAccount(user._id)).deleted).toBe(true);
    const second = await deleteUserAccount(user._id);
    expect(second).toEqual({ deleted: true, alreadyDeleted: true });
  });

  it("reports notFound for a principal with no User row", async () => {
    const { deleteUserAccount } = require("../../services/accountDeletionService");
    const res = await deleteUserAccount(new mongoose.Types.ObjectId());
    expect(res).toEqual({ deleted: false, notFound: true });
  });
});

describe("DELETE /api/account — referenced records", () => {
  it("RETAINS bookings (club/tournament integrity) with the registrant's contact details scrubbed", async () => {
    const user = await makeUser({ name: "Anita Rao" });
    const tournamentId = new mongoose.Types.ObjectId();

    const mine = await Booking.create({
      userId: user._id,
      userName: "Anita Rao",
      userEmail: user.email,
      userPhone: user.mobile,
      tournamentId,
      tournamentName: "Spring Open",
      tournamentType: "singles",
      paymentStatus: "paid",
      paymentAmount: 500,
    });
    const someoneElse = await Booking.create({
      userId: new mongoose.Types.ObjectId(),
      userName: "Other Player",
      userEmail: "other@test.local",
      userPhone: "9111111111",
      tournamentId,
      tournamentName: "Spring Open",
      tournamentType: "singles",
    });

    await del(tokenFor(user), { confirm: "DELETE" });

    // The financial/audit row is still there — the club's revenue history and
    // the tournament draw must not be corrupted by a player leaving.
    const after = await Booking.findById(mine._id);
    expect(after).toBeTruthy();
    expect(String(after.userId)).toBe(String(user._id)); // ref still resolves
    expect(after.paymentAmount).toBe(500);
    expect(after.paymentStatus).toBe("paid");
    // …but the denormalized contact copies are gone.
    expect(after.userName).toBe("Deleted User");
    expect(after.userEmail).toBe("");
    expect(after.userPhone).toBe("");

    // Nobody else's booking was touched.
    const other = await Booking.findById(someoneElse._id);
    expect(other.userName).toBe("Other Player");
    expect(other.userEmail).toBe("other@test.local");
  });

  it("PURGES the user's own posts and leaves other users' posts alone", async () => {
    const user = await makeUser();
    const other = await makeUser();

    const mine = await Post.create({
      tournamentName: "Spring Open",
      caption: "my match photo",
      user: user._id,
      userModel: "User",
    });
    const theirs = await Post.create({
      tournamentName: "Spring Open",
      caption: "their photo",
      user: other._id,
      userModel: "User",
      likes: [user._id],
      taggedUsers: [user._id],
    });

    await del(tokenFor(user), { confirm: "DELETE" });

    expect(await Post.findById(mine._id)).toBeNull();

    const survivor = await Post.findById(theirs._id);
    expect(survivor).toBeTruthy();
    // The deleted id is pulled out of live membership arrays so nothing
    // resolves to a tombstone.
    expect(survivor.likes.map(String)).not.toContain(String(user._id));
    expect(survivor.taggedUsers.map(String)).not.toContain(String(user._id));
  });

  it("PURGES sessions and push tokens", async () => {
    const user = await makeUser();
    await RefreshToken.create({
      userId: user._id,
      principalType: "User",
      tokenHash: "hash-" + user._id,
      expiresAt: new Date(Date.now() + 86400000),
    });
    await DeviceToken.create({
      userId: user._id,
      token: "ExponentPushToken[device-1]",
      allowNotifications: true,
    });

    await del(tokenFor(user), { confirm: "DELETE" });

    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    expect(await DeviceToken.countDocuments({ userId: user._id })).toBe(0);
  });

  it("removes the deleted user from other users' follower/following lists", async () => {
    const user = await makeUser();
    const friend = await makeUser();
    await User.updateOne({ _id: friend._id }, { $push: { followers: user._id, following: user._id } });
    await User.updateOne({ _id: user._id }, { $push: { following: friend._id } });

    await del(tokenFor(user), { confirm: "DELETE" });

    const friendAfter = await User.findById(friend._id);
    expect(friendAfter.followers.map(String)).not.toContain(String(user._id));
    expect(friendAfter.following.map(String)).not.toContain(String(user._id));
    expect((await User.findById(user._id)).following).toHaveLength(0);
  });

  it("does not attempt Apple revocation for a non-Apple account", async () => {
    const user = await makeUser();
    const res = await del(tokenFor(user), { confirm: "DELETE" });
    expect(res.body.appleTokenRevoked).toBeNull();
  });

  it("reports an unconfigured Apple revocation without failing the deletion", async () => {
    // APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY are not set in tests —
    // the deletion must still succeed (Guideline 5.1.1(v) first), with the
    // revocation reported as not done.
    const user = await makeUser({ appleId: "000123.delete.0001", authProvider: "apple" });
    const res = await del(tokenFor(user), { confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.appleTokenRevoked).toBe(false);
    expect((await User.findById(user._id)).isDeleted).toBe(true);
    expect((await User.findById(user._id)).appleId).toBeUndefined();
  });
});

describe("DELETE /api/auth/account — alias path", () => {
  it("works at the /api/auth/account path too", async () => {
    const user = await makeUser();
    const res = await request(app)
      .delete("/api/auth/account")
      .set("Authorization", `Bearer ${tokenFor(user)}`)
      .send({ confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect((await User.findById(user._id)).isDeleted).toBe(true);
  });

  it("rejects an unauthenticated call at the alias path too", async () => {
    const res = await request(app).delete("/api/auth/account").send({ confirm: "DELETE" });
    expect(res.status).toBe(401);
  });
});

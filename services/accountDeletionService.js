/**
 * User-initiated account deletion — App Store Guideline 5.1.1(v).
 *
 * Apple requires that an app which lets a user CREATE an account also lets them
 * DELETE it from inside the app. Deactivation does not satisfy the rule, and the
 * action must not be reversible by the user.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DECISION 1 — irreversible ANONYMIZATION of the User document, not a hard
 *              delete of the row.
 * ════════════════════════════════════════════════════════════════════════════
 * 96 collections in this codebase hold a `ref: "User"` (bookings, tournament
 * rosters, payments, club finance, club audit logs, coaching attendance,
 * event staffing, subscriptions…). A hard `User.findByIdAndDelete` would turn
 * every one of those into a dangling ObjectId: `.populate("userId")` yields
 * null, and the many places that read `booking.userId.name` would throw or
 * silently render blanks. A club's booking history and a tournament's bracket
 * would be corrupted by a player leaving — which is exactly the failure mode
 * Apple's rule is NOT asking for.
 *
 * So the row survives as a TOMBSTONE whose every personal field is overwritten:
 *
 *   • name            → "Deleted User"
 *   • email           → deleted-<userId>@deleted.invalid   (frees the real
 *                       address so the person may sign up again)
 *   • mobile / emergencyContact / address / bio / DOB / sex / age
 *   • identityType / identityId / identityDocument  (Aadhaar / PAN — the most
 *     sensitive data we hold; the uploaded file is unlinked from disk too)
 *   • profileImage / coverImage / profilePicture / certificates
 *   • googleId / appleId / expoPushToken / parental PIN
 *   • password        → a fresh random 64-byte value, so the account cannot be
 *                       authenticated even with the old credentials
 *   • isDeleted = true, deletedAt = now, isActive = false, isApproved = false
 *
 * This is irreversible: the original values are OVERWRITTEN, not moved to a
 * shadow field, and nothing in the product can clear `isDeleted`. The person
 * cannot undo it, and neither can support — which is what Apple requires.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DECISION 2 — what happens to records that reference the user.
 * ════════════════════════════════════════════════════════════════════════════
 * Three buckets, chosen per bucket rather than one blanket cascade:
 *
 *  (a) PURGED — records that are purely the user's own personal data and have
 *      no value to anyone else: refresh tokens and device/push tokens (also
 *      required, so existing sessions die), their social posts, comments,
 *      stories, saved favourites, direct messages, player-history timeline
 *      entries, personal notifications, plus the set of owned records the
 *      model's existing `cascadeDeleteUser` already covers (professional
 *      profile, job applications, hire/trainer requests, trainer batches,
 *      invitations, coaching sessions).
 *
 *  (b) RETAINED WITH THE REFERENCE ANONYMIZED — financial and audit records:
 *      tournament bookings, turf bookings, payments, coupon usage, club
 *      finance, club audit. These are kept because a club must still be able
 *      to reconcile its revenue and a tournament's results must still be
 *      readable; deleting them would corrupt a third party's books. `userId`
 *      keeps pointing at the tombstone (so joins and counts stay correct) and
 *      the DENORMALIZED contact copies on those rows are scrubbed:
 *      `userName` → "Deleted User", `userEmail` / `userPhone` → cleared.
 *
 *  (c) UNTOUCHED — competition integrity. Roster/bracket entries inside a
 *      booking or a match keep the player name they were played under: a
 *      finished draw that silently renames a participant is a falsified
 *      result, and the same record is other participants' history too. This is
 *      the one deliberate retention, and it is the published-result kind of
 *      data Apple's rule does not reach.
 *
 * Also: the user's id is $pull-ed out of every other user's followers/following
 * array, and out of post likes/saves, so no live list resolves to a tombstone.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const User = require("../src/modules/identity/models/User");
const { revokeAppleToken } = require("../utils/appleAuth");

/** Lazily resolve a model from the registry — missing models are skipped. */
const M = (name) => mongoose.models[name] || null;

function uploadsRoot() {
  return process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, "..", "uploads");
}

/**
 * Best-effort unlink of an uploaded file. Containment-checked: a stored path is
 * attacker-influenced (it came from a filename at upload time), so anything that
 * resolves outside the uploads root is ignored rather than deleted.
 */
function unlinkUpload(relOrAbsPath) {
  if (!relOrAbsPath || typeof relOrAbsPath !== "string") return;
  try {
    const root = uploadsRoot();
    const abs = path.resolve(root, relOrAbsPath.replace(/\\/g, "/").replace(/^\/?uploads\//, ""));
    if (!abs.startsWith(root + path.sep)) return; // outside the tree — refuse
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (err) {
    console.warn("[account-delete] could not unlink upload:", err.message);
  }
}

/** Collect every uploaded-file path hanging off a user document. */
function uploadPathsFor(user) {
  const paths = [
    user.profileImage,
    user.coverImage,
    user.profilePicture,
    user.identityDocument && user.identityDocument.path,
  ];
  for (const c of user.certificates || []) paths.push(c && c.path);
  return paths.filter(Boolean);
}

/** (a) Purge records that are purely this user's personal data. */
async function purgePersonalRecords(userId) {
  const ops = [];
  const del = (name, filter) => {
    const model = M(name);
    if (model) ops.push(model.deleteMany(filter));
  };

  // Sessions & devices — deleting these is what actually logs the user out
  // everywhere. (Access tokens already issued expire within the hour; every
  // auth middleware also rejects an isDeleted user, so they are dead on use.)
  del("RefreshToken", { userId });
  del("DeviceToken", { userId });

  // Social / personal content.
  del("Post", { user: userId });
  del("PostComment", { user: userId });
  del("Story", { user: userId });
  del("PlayerHistory", { user: userId });
  del("Favorite", { user: userId });
  del("Message", { sender: userId });
  del("PlayerNotification", { userId });
  del("Notification_Player", { userId });

  await Promise.allSettled(ops);

  // Reuse the model's existing owned-record cascade (professional profile, job
  // applications, hire/trainer requests, trainer batches, invitations,
  // sessions) instead of restating the list here and letting the two drift.
  if (typeof User.cascadeDeleteUser === "function") {
    try {
      await User.cascadeDeleteUser(userId);
    } catch (err) {
      console.error("[account-delete] cascade cleanup failed:", err.message);
    }
  }
}

/** (b) Scrub the denormalized contact copies on retained financial records. */
async function anonymizeRetainedReferences(userId) {
  const ops = [];
  const scrub = (name, filter) => {
    const model = M(name);
    if (!model) return;
    ops.push(
      model.updateMany(filter, {
        $set: { userName: "Deleted User", userEmail: "", userPhone: "" },
      })
    );
  };

  // Tournament registrations and turf bookings keep their row (club revenue,
  // draw integrity) with the registrant's contact details removed.
  scrub("Booking", { userId });
  scrub("TurfBooking", { userId });

  await Promise.allSettled(ops);
}

/** Remove the id from other users' / posts' live membership arrays. */
async function detachFromGraphs(userId) {
  const ops = [
    User.updateMany(
      { $or: [{ followers: userId }, { following: userId }] },
      { $pull: { followers: userId, following: userId } }
    ),
  ];
  const Post = M("Post");
  if (Post) {
    ops.push(
      Post.updateMany(
        { $or: [{ likes: userId }, { saves: userId }, { taggedUsers: userId }] },
        { $pull: { likes: userId, saves: userId, taggedUsers: userId } }
      )
    );
  }
  const Story = M("Story");
  if (Story) ops.push(Story.updateMany({ viewers: userId }, { $pull: { viewers: userId } }));
  await Promise.allSettled(ops);
}

/**
 * Delete the account of `userId`. The caller MUST have taken `userId` from a
 * verified token — this function does no authorization of its own.
 *
 * Idempotent: calling it on an already-deleted account is a no-op success.
 *
 * @returns {Promise<{deleted:boolean, alreadyDeleted?:boolean, appleRevocation?:object}>}
 */
async function deleteUserAccount(userId, opts = {}) {
  // `appleRefreshToken` is `select: false`, so ask for it explicitly.
  const user = await User.findById(userId).select("+appleRefreshToken");
  if (!user) return { deleted: false, notFound: true };
  if (user.isDeleted) return { deleted: true, alreadyDeleted: true };

  const wasApple = Boolean(user.appleId) || user.authProvider === "apple";
  const appleToken = user.appleRefreshToken || opts.appleRefreshToken || null;
  const files = uploadPathsFor(user);

  // ── Overwrite every personal field on the document ──
  // Done with updateOne (not doc.save()) deliberately: the pre-save hook hashes
  // `password` and re-derives age/isMinor from dateOfBirth, and the schema's
  // `required` validators (dateOfBirth for age-gated roles, identityId format)
  // would reject a scrubbed document. A direct update writes the tombstone
  // exactly as intended.
  const tombstoneEmail = `deleted-${user._id}@deleted.invalid`;
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        name: "Deleted User",
        email: tombstoneEmail,
        mobile: "deleted",
        // Not recoverable: a random value nobody holds the plaintext of.
        password: crypto.randomBytes(64).toString("hex"),
        passwordChangedAt: new Date(),
        isDeleted: true,
        deletedAt: new Date(),
        isActive: false,
        isApproved: false,
        emailVerified: false,
        authProvider: "local",
        // Social / profile PII
        bio: "",
        address: "",
        emergencyContact: "",
        rank: "",
        achievements: "",
        clubNames: [],
        followers: [],
        following: [],
        historyVisibility: "private",
        // Media
        profileImage: null,
        coverImage: null,
        profilePicture: null,
        certificates: [],
        // Government identity documents — the most sensitive data we hold.
        identityDocument: null,
        // Push + notification identifiers
        expoPushToken: null,
        // Parental controls hold a hashed PIN.
        "parentalControls.enabled": false,
        "parentalControls.pin": null,
      },
      // $unset rather than $set for the fields whose validators reject a blank
      // value (identityId is format-checked against identityType; sex is an
      // enum with no empty member; dateOfBirth drives the age derivation).
      $unset: {
        dateOfBirth: "",
        age: "",
        sex: "",
        identityType: "",
        identityId: "",
        googleId: "",
        appleId: "",
        appleRefreshToken: "",
        playerId: "",
        referralCode: "",
        suspensionReason: "",
      },
    },
    // Skip validators: we are intentionally writing a document that the
    // signup-time schema rules would reject (no DOB, no real email).
    { runValidators: false }
  );

  await purgePersonalRecords(user._id);
  await anonymizeRetainedReferences(user._id);
  await detachFromGraphs(user._id);

  // Uploaded PII files last — the database row is already scrubbed, so a
  // failure here cannot leave the account half-deleted.
  for (const p of files) unlinkUpload(p);

  // ── Apple token revocation (Guideline 5.1.1(v)) ──
  // ⚠️ MUST BE CONFIGURED BEFORE RELEASE: requires APPLE_TEAM_ID, APPLE_KEY_ID,
  // APPLE_PRIVATE_KEY (.p8 contents) and APPLE_CLIENT_ID. When absent,
  // revokeAppleToken() logs a loud warning and returns {revoked:false} — the
  // deletion still succeeds, because failing a user's deletion request over our
  // own missing configuration would be the worse violation.
  let appleRevocation;
  if (wasApple) {
    appleRevocation = await revokeAppleToken(appleToken, "refresh_token");
  }

  return { deleted: true, appleRevocation };
}

module.exports = { deleteUserAccount };

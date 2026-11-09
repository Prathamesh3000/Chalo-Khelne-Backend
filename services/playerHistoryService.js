const mongoose = require('mongoose');
const PlayerHistory = require('../src/modules/social/models/PlayerHistory');
const Tournament = require('../src/modules/tournaments/models/Tournament');
const Booking = require('../src/modules/tournaments/models/BookingModel');
const User = require('../src/modules/identity/models/User');
const escapeRegex = require('../utils/escapeRegex');

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

/** Single-sport tournaments report that sport; multi-sport ones leave it blank. */
function sportOf(tournament) {
  const sports = tournament && tournament.sports;
  return Array.isArray(sports) && sports.length === 1 ? sports[0].sportName || undefined : undefined;
}

/** Tournament.startDate is a free String; return a Date only if it parses. */
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Case-insensitive exact match on a tournament's title or name. */
async function findTournamentByName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const rx = new RegExp(`^${escapeRegex(trimmed)}$`, 'i');
  return Tournament.findOne({ $or: [{ title: rx }, { name: rx }] });
}

/**
 * Verified = the tournament exists AND the player is registered or on the
 * roster of a non-cancelled booking for it. Roster ids are stored as strings
 * on Booking.team, the registrant as an ObjectId on Booking.userId.
 */
async function isVerified(userId, tournamentId) {
  if (!isId(userId) || !isId(tournamentId)) return false;
  const uid = String(userId);
  const hit = await Booking.exists({
    tournamentId,
    status: { $ne: 'cancelled' },
    $or: [
      { userId: uid },
      { 'team.roster.userId': uid },
      { 'team.players.id': uid },
      { 'team.captain.id': uid },
    ],
  });
  return !!hit;
}

/** Keep only ids that belong to real User accounts; drop dupes and `exclude`. */
async function resolveTaggedUsers(ids, exclude) {
  const wanted = [...new Set((ids || []).map(String).filter(isId))].filter(
    (id) => id !== String(exclude || '')
  );
  if (!wanted.length) return [];
  const found = await User.find({ _id: { $in: wanted } }).select('_id').lean();
  return found.map((u) => u._id);
}

/**
 * Called from createPost. Writes the author's ACTIVE entry (if the author is a
 * player account) and a PENDING entry for every tagged player. Idempotent per
 * (player, post) thanks to the unique partial index.
 */
async function recordFromPost({ post, tournament, authorId, authorIsPlayer, taggedUserIds }) {
  const base = {
    tournamentName: post.tournamentName,
    tournamentId: tournament._id,
    sport: sportOf(tournament),
    eventDate: post.eventDate || parseDate(tournament.startDate) || post.createdAt,
    location: post.location,
    description: post.caption,
    images: post.images,
    postId: post._id,
  };
  const created = [];

  if (authorIsPlayer) {
    created.push(
      await upsertForPost(authorId, {
        ...base,
        source: 'post',
        status: 'active',
        verified: await isVerified(authorId, tournament._id),
      })
    );
  }

  for (const uid of taggedUserIds) {
    created.push(
      await upsertForPost(uid, {
        ...base,
        source: 'tagged',
        status: 'pending',
        taggedBy: authorIsPlayer ? authorId : null,
        verified: await isVerified(uid, tournament._id),
      })
    );
  }
  return created;
}

async function upsertForPost(userId, fields) {
  try {
    // $setOnInsert so a re-run never resets an entry the player already
    // approved/rejected or edited.
    return await PlayerHistory.findOneAndUpdate(
      { user: userId, postId: fields.postId },
      { $setOnInsert: { user: userId, ...fields } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      return PlayerHistory.findOne({ user: userId, postId: fields.postId });
    }
    throw err;
  }
}

/**
 * One-time conversion of the legacy free-text `User.achievements` (one
 * achievement per line) into self-reported timeline entries. Runs lazily the
 * first time a player's timeline is read, so no deploy-time script is needed.
 *
 * Idempotent and race-safe: the user is "claimed" with an atomic update on
 * `achievementsMigratedAt: null`, so two concurrent reads can't both insert.
 * The original text is left in place as a backup.
 */
async function migrateLegacyAchievements(userId) {
  if (!isId(userId)) return 0;
  const claimed = await User.findOneAndUpdate(
    { _id: userId, achievementsMigratedAt: null },
    { $set: { achievementsMigratedAt: new Date() } },
    { new: false, projection: { achievements: 1 } }
  ).lean();
  if (!claimed) return 0; // already migrated, or no such user

  const lines = String(claimed.achievements || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return 0;

  // No date is known for old achievements; createdAt keeps their order stable.
  try {
    await PlayerHistory.insertMany(
      lines.map((tournamentName) => ({
        user: userId,
        status: 'active',
        source: 'profile',
        tournamentName,
        verified: false,
      }))
    );
  } catch (err) {
    // Release the claim so the next read retries instead of silently losing
    // the migration.
    await User.updateOne({ _id: userId }, { $set: { achievementsMigratedAt: null } });
    throw err;
  }
  return lines.length;
}

module.exports = {
  findTournamentByName,
  migrateLegacyAchievements,
  sportOf,
  parseDate,
  isVerified,
  resolveTaggedUsers,
  recordFromPost,
};

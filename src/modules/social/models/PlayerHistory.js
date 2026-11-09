const mongoose = require('mongoose');

/**
 * PlayerHistory — one event on a player's profile timeline.
 *
 * This is deliberately a SEPARATE record from Post. A post can be deleted by its
 * author; the match it described is still part of that player's history, so the
 * entry must never depend on the post existing. `postId` is a back-reference
 * only and is never populated as a requirement.
 *
 * status:
 *   active   — shown on the timeline
 *   pending  — someone else tagged this player in a post; invisible until the
 *              player approves it
 *   rejected — the tagged player declined; kept so the same post can't re-prompt
 *
 * verified is computed server-side (never trusted from the client): true when
 * the tournament exists in our database AND the player is registered / on the
 * roster of a non-cancelled booking for it.
 */
const playerHistorySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['active', 'pending', 'rejected'],
      default: 'active',
    },
    source: {
      type: String,
      enum: ['signup', 'profile', 'post', 'tagged'],
      default: 'profile',
    },

    tournamentName: { type: String, required: true, trim: true },
    tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', default: null },
    sport: { type: String, trim: true },
    eventDate: { type: Date },
    result: { type: String, trim: true }, // e.g. "Winner", "Runner-up", "Semi-finalist"
    location: { type: String, trim: true },
    description: { type: String, trim: true },
    images: [{ type: String }],

    verified: { type: Boolean, default: false },

    // Back-reference to the social post that produced this entry (if any).
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
    // Who tagged the player (source === 'tagged').
    taggedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// A player's timeline, newest event first.
playerHistorySchema.index({ user: 1, status: 1, eventDate: -1 });
// One entry per (player, post): re-running a post flow can't duplicate it.
playerHistorySchema.index(
  { user: 1, postId: 1 },
  { unique: true, partialFilterExpression: { postId: { $type: 'objectId' } } }
);

module.exports =
  mongoose.models.PlayerHistory || mongoose.model('PlayerHistory', playerHistorySchema);

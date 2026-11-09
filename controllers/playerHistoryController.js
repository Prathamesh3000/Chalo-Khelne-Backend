const mongoose = require('mongoose');
const PlayerHistory = require('../src/modules/social/models/PlayerHistory');
const User = require('../src/modules/identity/models/User');
const svc = require('../services/playerHistoryService');
const { getRelativePath, cleanupFile } = require('../middleware/uploads');

const MAX_IMAGES = 5;
const MANUAL_SOURCES = ['signup', 'profile'];
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

const meId = (req) => String(req.user.id || req.user._id);
// History belongs to player accounts. Managers/SuperAdmins can read timelines
// but have none of their own to write.
const isPlayer = (req) => req.userRole === 'User';

const filePaths = (req) => (req.files || []).map((f) => getRelativePath(f.path));
const cleanupUploads = (req) => (req.files || []).forEach((f) => cleanupFile(f.path));

function serialize(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id),
    user: String(o.user && o.user._id ? o.user._id : o.user),
    status: o.status,
    source: o.source,
    tournamentName: o.tournamentName,
    tournamentId: o.tournamentId ? String(o.tournamentId) : null,
    sport: o.sport || null,
    eventDate: o.eventDate || null,
    result: o.result || null,
    location: o.location || null,
    description: o.description || null,
    images: o.images || [],
    verified: !!o.verified,
    postId: o.postId ? String(o.postId) : null,
    taggedBy: o.taggedBy
      ? o.taggedBy._id
        ? { id: String(o.taggedBy._id), name: o.taggedBy.name }
        : { id: String(o.taggedBy) }
      : null,
    createdAt: o.createdAt,
    teammates: o.teammates || [],
  };
}

/**
 * Other players who share a post-backed entry with each of `entries`.
 * A teammate is someone holding an ACTIVE entry for the same post (the author,
 * and tagged players who approved). Pending/rejected tags never appear, so a
 * player who declined is not exposed on someone else's timeline.
 * Returns Map(postId -> [{ id, name, avatar }]).
 */
async function teammatesByPost(entries, ownerId) {
  const postIds = [...new Set(entries.filter((e) => e.postId).map((e) => String(e.postId)))];
  const map = new Map();
  if (!postIds.length) return map;
  const mates = await PlayerHistory.find({
    postId: { $in: postIds },
    status: 'active',
    user: { $ne: ownerId },
  })
    .select('postId user')
    .populate('user', 'name profileImage profilePicture')
    .lean();
  mates.forEach((m) => {
    if (!m.user) return;
    const key = String(m.postId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: String(m.user._id),
      name: m.user.name || '',
      avatar: m.user.profileImage || m.user.profilePicture || null,
    });
  });
  return map;
}

// GET /api/player-history/user/:userId — a player's visible timeline.
// Only ACTIVE entries are ever returned here, to the owner included: pending
// entries are an inbox (GET /pending), not part of the timeline.
exports.listForUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isId(userId)) return res.status(400).json({ success: false, message: 'Invalid user id' });

    // Convert legacy free-text achievements on first read. A failure here must
    // not take the timeline down; the service releases its claim on failure so
    // the next read retries.
    try {
      await svc.migrateLegacyAchievements(userId);
    } catch (migrateErr) {
      console.error('[player-history] achievements migration failed:', migrateErr);
    }

    const isOwner = isPlayer(req) && meId(req) === String(userId);
    if (!isOwner && !req.isSuperAdmin) {
      const owner = await User.findById(userId).select('historyVisibility').lean();
      if (!owner) return res.status(404).json({ success: false, message: 'Player not found' });
      const visibility = owner.historyVisibility || 'public';
      // A viewer "follows" the owner when the owner is in their `following`.
      const follows =
        isPlayer(req) && (req.user.following || []).some((id) => String(id) === String(userId));
      if (visibility === 'private' || (visibility === 'followers' && !follows)) {
        // 200 with a flag, not 403: the profile screen shows a lock note
        // instead of treating it as an error.
        return res.json({ success: true, entries: [], restricted: visibility });
      }
    }

    const entries = await PlayerHistory.find({ user: userId, status: 'active' })
      .sort({ eventDate: -1, createdAt: -1 })
      .limit(200);

    const mates = await teammatesByPost(entries, userId);
    res.json({
      success: true,
      entries: entries.map((e) =>
        serialize({ ...e.toObject(), teammates: mates.get(String(e.postId)) || [] })
      ),
    });
  } catch (err) {
    console.error('[player-history] list failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const VISIBILITIES = ['public', 'followers', 'private'];

// GET /api/player-history/settings — my timeline visibility.
exports.getSettings = async (req, res) => {
  try {
    if (!isPlayer(req)) return res.json({ success: true, visibility: 'public' });
    res.json({ success: true, visibility: req.user.historyVisibility || 'public' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/player-history/settings  { visibility }
exports.updateSettings = async (req, res) => {
  try {
    if (!isPlayer(req)) {
      return res.status(403).json({ success: false, message: 'Only players have a history timeline' });
    }
    const visibility = req.body && req.body.visibility;
    if (!VISIBILITIES.includes(visibility)) {
      return res.status(400).json({
        success: false,
        message: `visibility must be one of: ${VISIBILITIES.join(', ')}`,
      });
    }
    await User.updateOne({ _id: meId(req) }, { $set: { historyVisibility: visibility } });
    res.json({ success: true, visibility });
  } catch (err) {
    console.error('[player-history] settings failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/player-history/pending — entries other players tagged me in.
exports.listPending = async (req, res) => {
  try {
    if (!isPlayer(req)) return res.json({ success: true, entries: [] });
    const entries = await PlayerHistory.find({ user: meId(req), status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('taggedBy', 'name');
    res.json({ success: true, entries: entries.map(serialize) });
  } catch (err) {
    console.error('[player-history] pending failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/player-history — add an entry by hand (sign-up / profile).
// multipart: fields below + up to 5 `historyImages`.
exports.create = async (req, res) => {
  try {
    if (!isPlayer(req)) {
      cleanupUploads(req);
      return res.status(403).json({ success: false, message: 'Only players have a history timeline' });
    }
    const b = req.body || {};
    const tournamentName = String(b.tournamentName || '').trim();
    if (!tournamentName) {
      cleanupUploads(req);
      return res.status(400).json({ success: false, message: 'Tournament name is required' });
    }
    const eventDate = b.eventDate ? svc.parseDate(b.eventDate) : null;
    if (b.eventDate && !eventDate) {
      cleanupUploads(req);
      return res.status(400).json({ success: false, message: 'eventDate is not a valid date' });
    }
    if ((req.files || []).length > MAX_IMAGES) {
      cleanupUploads(req);
      return res.status(400).json({ success: false, message: `At most ${MAX_IMAGES} images` });
    }

    // Link to a real tournament when the name matches one; `verified` is then
    // decided by the server from bookings, never by the client.
    const tournament = await svc.findTournamentByName(tournamentName);
    const verified = tournament ? await svc.isVerified(meId(req), tournament._id) : false;

    const entry = await PlayerHistory.create({
      user: meId(req),
      status: 'active',
      source: MANUAL_SOURCES.includes(b.source) ? b.source : 'profile',
      tournamentName: tournament ? tournament.title || tournamentName : tournamentName,
      tournamentId: tournament ? tournament._id : null,
      sport: b.sport || svc.sportOf(tournament) || undefined,
      eventDate: eventDate || (tournament && svc.parseDate(tournament.startDate)) || undefined,
      result: b.result,
      location: b.location,
      description: b.description,
      images: filePaths(req),
      verified,
    });
    res.status(201).json({ success: true, entry: serialize(entry) });
  } catch (err) {
    console.error('[player-history] create failed:', err);
    cleanupUploads(req);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/player-history/:id — owner edits their own active entry.
// The tournament link and `verified` are not editable: they are facts the
// server established, not text the player gets to rewrite.
exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) {
      cleanupUploads(req);
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const entry = await PlayerHistory.findById(id);
    if (!entry || !isPlayer(req) || String(entry.user) !== meId(req)) {
      cleanupUploads(req);
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }
    if (entry.status !== 'active') {
      cleanupUploads(req);
      return res.status(409).json({ success: false, message: 'Approve this entry before editing it' });
    }

    const b = req.body || {};
    for (const f of ['sport', 'result', 'location', 'description']) {
      if (b[f] !== undefined) entry[f] = b[f];
    }
    if (b.eventDate !== undefined) {
      const d = svc.parseDate(b.eventDate);
      if (b.eventDate && !d) {
        cleanupUploads(req);
        return res.status(400).json({ success: false, message: 'eventDate is not a valid date' });
      }
      entry.eventDate = d || undefined;
    }

    // Images: drop the ones the client lists in removeImages, then append uploads.
    const remove = [].concat(b.removeImages || []).map(String);
    const kept = entry.images.filter((p) => !remove.includes(p));
    const next = [...kept, ...filePaths(req)];
    if (next.length > MAX_IMAGES) {
      cleanupUploads(req);
      return res.status(400).json({ success: false, message: `At most ${MAX_IMAGES} images` });
    }
    entry.images = next;

    await entry.save();
    res.json({ success: true, entry: serialize(entry) });
  } catch (err) {
    console.error('[player-history] update failed:', err);
    cleanupUploads(req);
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/player-history/:id — owner removes their own entry.
exports.remove = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const entry = await PlayerHistory.findById(id);
    if (!entry || !isPlayer(req) || String(entry.user) !== meId(req)) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }
    await entry.deleteOne();
    res.json({ success: true });
  } catch (err) {
    console.error('[player-history] delete failed:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/player-history/:id/approve | /reject — the tagged player decides.
const decide = (status) => async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const entry = await PlayerHistory.findById(id);
    if (!entry || !isPlayer(req) || String(entry.user) !== meId(req)) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }
    if (entry.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Entry is already ${entry.status}` });
    }
    entry.status = status;
    await entry.save();
    res.json({ success: true, entry: serialize(entry) });
  } catch (err) {
    console.error(`[player-history] ${status} failed:`, err);
    res.status(500).json({ success: false, message: err.message });
  }
};
exports.approve = decide('active');
exports.reject = decide('rejected');

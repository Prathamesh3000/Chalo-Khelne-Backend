// server/utils/sportTrackUtils.js
//
// Helpers for accessing per-sport configuration on a Tournament.
// Tournaments store their per-sport state in `tournament.sports[]`.
//
// STEP 17d — synthesizeLegacyTrack DELETED. Every Tournament has
// sports[] populated post-STEP-16; helpers no longer fall back to
// root scalars. Callers receive null/[]/{} when sports[] is missing
// and apply their own display defaults.

// Find a sport-track on a tournament. Returns null when sports[] is
// missing/empty. When sportId is omitted on a multi-sport tournament,
// returns the first track (callers should provide sportId for correctness).
function getSportTrack(tournament, sportId) {
  if (!tournament) return null;
  const tracks = Array.isArray(tournament.sports) ? tournament.sports : [];
  if (tracks.length === 0) return null;
  if (!sportId) return tracks[0];
  const sportIdStr = String(sportId);
  return tracks.find((t) => String(t.sportId) === sportIdStr) || null;
}

// All sport tracks. Returns [] when sports[] is missing.
function listSportTracks(tournament) {
  if (!tournament) return [];
  return Array.isArray(tournament.sports) ? tournament.sports : [];
}

// Get the active stage for a specific sport on a tournament.
function getCurrentStage(tournament, sportId) {
  const track = getSportTrack(tournament, sportId);
  return track?.currentStage || "registration";
}

// Update currentStage for a specific sport. Falls back to root scalar for
// legacy tournaments. Lazy-requires Tournament to avoid circular imports.
async function setCurrentStage(tournamentId, sportId, stage) {
  const Tournament = require("../src/modules/tournaments/models/Tournament");
  if (!sportId) {
    return Tournament.findByIdAndUpdate(
      tournamentId,
      { currentStage: stage },
      { new: true }
    );
  }
  return Tournament.findOneAndUpdate(
    { _id: tournamentId, "sports.sportId": sportId },
    { $set: { "sports.$.currentStage": stage } },
    { new: true }
  );
}

// Set currentStage on EVERY sport track of a tournament (e.g. mark the whole
// tournament completed). Writes the per-sport tracks via the all-positional
// operator — never the root `currentStage`, which the schema no longer declares
// (Mongoose strict mode drops such writes silently).
async function setAllTracksStage(tournamentId, stage) {
  const Tournament = require("../src/modules/tournaments/models/Tournament");
  return Tournament.findOneAndUpdate(
    { _id: tournamentId },
    { $set: { "sports.$[].currentStage": stage } },
    { new: true }
  );
}

// Update a stageConfig dot-path on a specific sport-track. `path` is
// relative to stageConfig (e.g., "qualifierKnockout.enabled").
async function setStageConfigPath(tournamentId, sportId, path, value) {
  const Tournament = require("../src/modules/tournaments/models/Tournament");
  if (!sportId) {
    return Tournament.findByIdAndUpdate(
      tournamentId,
      { $set: { [`stageConfig.${path}`]: value } },
      { new: true }
    );
  }
  return Tournament.findOneAndUpdate(
    { _id: tournamentId, "sports.sportId": sportId },
    { $set: { [`sports.$.stageConfig.${path}`]: value } },
    { new: true }
  );
}

// Get matchFormat for a specific sport-track. Falls back to root scalar.
function getMatchFormat(tournament, sportId) {
  const track = getSportTrack(tournament, sportId);
  return track?.matchFormat || null;
}

// Resolved sportName for a specific track.
// STEP 17d — legacy `tournament.sportsType` fallback removed.
function getSportName(tournament, sportId) {
  return getSportTrack(tournament, sportId)?.sportName || null;
}

// STEP 17b.i — per-sport readers for fields that used to live on the
// Tournament root. All resolve via getSportTrack so they inherit the
// legacy-fallback path until 17d removes synthesizeLegacyTrack.
// The three structural getters below take an OPTIONAL categoryName. When one
// is passed and that category carries its own value, the category wins;
// otherwise the track value applies, exactly as before. Callers with no
// category in hand keep the old two-argument behaviour, so nothing that
// already works changes.
function getTournamentType(tournament, sportId, categoryName) {
  const track = getSportTrack(tournament, sportId);
  const category = getCategory(tournament, sportId, categoryName);
  return category?.type || track?.type || null;
}
function getCategories(tournament, sportId) {
  const track = getSportTrack(tournament, sportId);
  return Array.isArray(track?.categories) ? track.categories : [];
}
function getQualifyPerGroup(tournament, sportId, categoryName) {
  const track = getSportTrack(tournament, sportId);
  const category = getCategory(tournament, sportId, categoryName);
  return category?.qualifyPerGroup ?? track?.qualifyPerGroup ?? 2;
}
function getDrawSize(tournament, sportId, categoryName) {
  const track = getSportTrack(tournament, sportId);
  const category = getCategory(tournament, sportId, categoryName);
  return category?.drawSize ?? track?.drawSize ?? null;
}
// Authoring mode for the wizard — see the schema note on sportTrack.formatScope.
// Never gates resolution; a category override is honoured in either mode.
function getFormatScope(tournament, sportId) {
  const track = getSportTrack(tournament, sportId);
  return track?.formatScope === "category" ? "category" : "sport";
}
// Find one category row on a sport track by name. Matching is
// case-insensitive and whitespace-trimmed because the name is the only link
// between a BookingGroup (which stores `category` as a free string) and the
// category row on the tournament.
function getCategory(tournament, sportId, categoryName) {
  if (!categoryName) return null;
  const wanted = String(categoryName).trim().toLowerCase();
  if (!wanted) return null;
  return (
    getCategories(tournament, sportId).find(
      (c) => String(c?.name || "").trim().toLowerCase() === wanted
    ) || null
  );
}

// A sport track holds ONE groupStageFormat/knockoutFormat for all of its
// categories, and the enum allows the combined value "Singles, Doubles" for
// tracks that run both. Neither can express which of the two a given category
// is, so resolution goes, in order:
//
//   1. the category's own override, when one is set;
//   2. the track value, when it names a single format;
//   3. for the combined "Singles, Doubles", the category name — the only
//      remaining signal, and reliable in practice because category names come
//      from SuperAdmin-controlled templates ("Men's Doubles", "Mixed
//      Doubles", "Singles", ...);
//   4. null, leaving the default to the caller.
//
// Passing no categoryName gives the old track-only behaviour, so existing
// callers that have no category in hand are unaffected.
const COMBINED_FORMAT = "Singles, Doubles";

function _resolveFormat(trackValue, categoryValue, categoryName) {
  if (categoryValue) return categoryValue;
  if (trackValue && trackValue !== COMBINED_FORMAT) return trackValue;
  if (trackValue === COMBINED_FORMAT) {
    // "Men's Doubles" / "Mixed Doubles" / "Doubles" → Doubles; anything else
    // in a combined track is singles.
    return /doubles/i.test(String(categoryName || "")) ? "Doubles" : "Singles";
  }
  return null;
}

function getGroupStageFormat(tournament, sportId, categoryName) {
  const track = getSportTrack(tournament, sportId);
  if (!track) return null;
  const category = getCategory(tournament, sportId, categoryName);
  return _resolveFormat(
    track.groupStageFormat || null,
    category?.groupStageFormat || null,
    categoryName
  );
}

function getKnockoutFormat(tournament, sportId, categoryName) {
  const track = getSportTrack(tournament, sportId);
  if (!track) return null;
  const category = getCategory(tournament, sportId, categoryName);
  return _resolveFormat(
    track.knockoutFormat || null,
    category?.knockoutFormat || null,
    categoryName
  );
}
function getDavisCupFormatId(tournament, sportId) {
  const track = getSportTrack(tournament, sportId);
  return track?.davisCupFormatId || null;
}
function getSportRules(tournament, sportId) {
  const track = getSportTrack(tournament, sportId);
  return track?.sportRules || null;
}
function getStageConfig(tournament, sportId) {
  const track = getSportTrack(tournament, sportId);
  if (!track) return {};
  return track.stageConfig?.toObject?.() || track.stageConfig || {};
}

// Resolve which sportId to stamp on a new doc. Same fallback chain
// MatchFactory's _stamp uses, exposed for non-factory callers (controllers
// writing TopPlayers, BookingGroup, GroupStandings, SuperPlayers, etc.):
// explicit > tournament.sports[0].sportId > null.
function resolveSportId(tournament, providedSportId) {
  if (providedSportId) return providedSportId;
  return tournament?.sports?.[0]?.sportId || null;
}

module.exports = {
  getSportTrack,
  listSportTracks,
  getCurrentStage,
  setCurrentStage,
  setAllTracksStage,
  setStageConfigPath,
  getMatchFormat,
  getSportName,
  resolveSportId,
  getTournamentType,
  getCategories,
  getCategory,
  getQualifyPerGroup,
  getDrawSize,
  getFormatScope,
  getGroupStageFormat,
  getKnockoutFormat,
  getDavisCupFormatId,
  getSportRules,
  getStageConfig,
};

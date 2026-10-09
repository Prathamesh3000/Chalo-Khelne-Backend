const Tournament = require("../src/modules/tournaments/models/Tournament");
const escapeRegex = require("../utils/escapeRegex");
const Booking = require("../src/modules/tournaments/models/BookingModel");
const BookingGroup = require("../src/modules/tournaments/models/bookinggroup");
const Score = require("../src/modules/tournaments/models/Score");
const Match = require("../src/modules/tournaments/models/Tournnamentmatch");
const KnockoutMatch = require("../src/modules/tournaments/models/KnockoutMatch");
const SuperMatch = require("../src/modules/tournaments/models/SuperMatch");
const DirectKnockoutMatch = require("../src/modules/tournaments/models/DirectKnockoutMatch");
// Additional models for full tournament-delete cascade.
const GroupStandings = require("../src/modules/tournaments/models/GroupStandings");
const TeamKnockout = require("../src/modules/tournaments/models/TeamKnockout");
const TeamKnockoutMatches = require("../src/modules/tournaments/models/TeamKnockoutMatches");
const TeamKnockoutTeams = require("../src/modules/tournaments/models/TeamKnockoutTeams");
const PlayerPayment = require("../src/modules/commerce/models/playerPaymentSchema");
const User = require("../src/modules/identity/models/User");
const SportRuleBook = require("../src/modules/catalog/models/SportRuleBook");
const { sanitizeBySportType, validateCustomRules, normalizeMatchFormat, getScoringType } = require("../utils/matchFormatUtils");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const Turf = require('../src/modules/org/models/Turf')
const { uploadsDir } = require("../middleware/uploads");
const notificationController = require("./notificationController");
const TopPlayers = require("../src/modules/tournaments/models/TopPlayers");
const SuperPlayers = require("../src/modules/tournaments/models/SuperPlayers");
const Sport = require("../src/modules/catalog/models/Sport");
const { createSuperMatch, createLegacyKnockoutMatch } = require("../factories/MatchFactory");
const { sanitizeMatchFormat, validateMatchFormat: validateSportMatchFormat } = require("../utils/sportFieldConfig");
const { assertNonEmptySports, assertSportInTournament, assertGroupHasSport, handleSportContextError } = require("../middleware/requireSportContext");
const { getSeedOrder, buildR1SlotAssignment } = require("../utils/seedingUtils");
const { shuffle } = require("../utils/shuffle");

// Per-tournament generation lock — prevents concurrent /knockout/generate
// requests (frontend timeout + retry) from racing each other.
const knockoutGenerationLocks = new Set();
const VALID_KO_DRAW_SIZES = [4, 8, 16, 32, 64, 128];

// ===================== ROUND 2 PROGRESSION SYSTEM =====================

// Check Round 2 Status
exports.getRound2Status = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { sportId } = req.query;

    // Check tournament stage
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // STEP 17b.iv — read currentStage per-sport. Defaults to sports[0]
    // when sportId is omitted (no legacy root fallback).
    const { getCurrentStage } = require("../utils/sportTrackUtils");
    const sportCurrentStage = getCurrentStage(tournament, sportId);

    // Round 2 groups: BookingGroup filter includes null sportId so
    // pre-migration groups don't disappear when filter is active.
    const groupFilter = sportId
      ? { tournamentId, round: 2, $or: [{ sportId }, { sportId: null }] }
      : { tournamentId, round: 2 };
    const round2Groups = await BookingGroup.find(groupFilter);

    if (round2Groups.length > 0) {
      return res.json({
        success: true,
        status: {
          option: 'group_stage',
          status: 'initiated',
          groupsCount: round2Groups.length
        }
      });
    }

    // Check if knockout has been initiated for this sport.
    if (sportCurrentStage === 'qualifier_knockout') {
      return res.json({
        success: true,
        status: {
          option: 'knockout',
          status: 'initiated'
        }
      });
    }

    // No Round 2 initiated yet
    return res.json({
      success: false,
      message: "Round 2 not initiated yet"
    });

  } catch (error) {
    console.error("Error checking Round 2 status:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

// Initiate Round 2
exports.initiateRound2 = async (req, res) => {
  try {
    const { tournamentId, option, topPlayers } = req.body;

    // Validate input
    if (!tournamentId || !option || !topPlayers || topPlayers.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Invalid input. Need at least 2 top players."
      });
    }

    // Validate tournament exists
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    if (option === 'knockout') {
      // Update tournament stage to qualifier knockout (only update the stage fields)
      await Tournament.findByIdAndUpdate(tournamentId, {
        currentStage: 'qualifier_knockout',
        'stageConfig.qualifierKnockout.enabled': true
      });

      // Here you can add knockout bracket generation logic
      // For now, we'll just mark it as initiated

      return res.json({
        success: true,
        message: "Round 2 Knockout initiated successfully",
        data: { option: 'knockout', status: 'initiated' }
      });

    } else if (option === 'group_stage') {
      // Mark for Round 2 Group Stage (only update the stage fields)
      await Tournament.findByIdAndUpdate(tournamentId, {
        currentStage: 'qualifier_knockout',
        'stageConfig.qualifierKnockout.enabled': true
      });

      return res.json({
        success: true,
        message: "Ready for Round 2 Group Stage creation",
        data: { option: 'group_stage', status: 'initiated' }
      });
    }

    return res.status(400).json({
      success: false,
      message: "Invalid option. Must be 'knockout' or 'group_stage'."
    });

  } catch (error) {
    console.error("Error initiating Round 2:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

// Create Round 2 Groups
exports.createRound2Groups = async (req, res) => {
  try {
    const { tournamentId, groups, topPlayers } = req.body;

    // Validate input
    if (!tournamentId || !groups || !topPlayers) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    // Validate tournament exists
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // STEP 16d — sportId required at the boundary for Round 2 group create.
    try {
      assertSportInTournament(req.body.sportId, tournament);
    } catch (err) {
      if (handleSportContextError(err, res)) return;
      throw err;
    }

    const createdGroups = [];

    // Create Round 2 groups
    for (let groupConfig of groups) {
      const { groupName, players } = groupConfig;

      // Convert top players data to booking group format
      const groupPlayers = players.map(player => ({
        playerId: player.playerId,
        userName: player.playerName,
        bookingDate: new Date(),
        joinedAt: new Date()
      }));

      const round2Group = new BookingGroup({
        tournamentId,
        sportId: req.body.sportId,
        groupName,
        category: players[0]?.category || 'Open',
        players: groupPlayers,
        round: 2, // Mark as Round 2
        roundType: 'qualifier',
        status: 'active'
      });

      await round2Group.save();
      createdGroups.push(round2Group);
    }

    // Update tournament stage (only the fields we need)
    await Tournament.findByIdAndUpdate(tournamentId, {
      currentStage: 'qualifier_knockout',
      'stageConfig.qualifierKnockout.enabled': true
    });

    return res.json({
      success: true,
      message: "Round 2 groups created successfully",
      groups: createdGroups
    });

  } catch (error) {
    console.error("Error creating Round 2 groups:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

// Get Round 2 Groups
exports.getRound2Groups = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { sportId } = req.query;

    // Multi-sport: include sportId-null docs so pre-migration groups
    // don't disappear when the filter is active (same pattern as
    // getBookingGroups per STEP 11a approval fix).
    const filter = sportId
      ? { tournamentId, round: 2, $or: [{ sportId }, { sportId: null }] }
      : { tournamentId, round: 2 };
    const round2Groups = await BookingGroup.find(filter).populate({
      path: "players.playerId",
      select: "name profileImage"
    });

    return res.json({
      success: true,
      groups: round2Groups
    });

  } catch (error) {
    console.error("Error fetching Round 2 groups:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

// Identify Super Players (winners of Round 2)
exports.identifySuperPlayers = async (req, res) => {
  try {
    const { tournamentId } = req.body;

    // Find all Round 2 groups
    const round2Groups = await BookingGroup.find({
      tournamentId,
      round: 2,
      status: 'completed' // Only from completed Round 2 groups
    });

    if (round2Groups.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No completed Round 2 groups found"
      });
    }

    const superPlayers = [];

    // Pick each group's winner from real standings (top by totalPoints, then
    // wins, then rounds-won as tiebreakers). Falls back to group.players[0]
    // only when standings haven't been recorded yet (groups with no completed
    // matches) — logged so the fallback is visible in ops.
    const GroupStandings = require("../src/modules/tournaments/models/GroupStandings");
    for (let group of round2Groups) {
      const standingsDoc = await GroupStandings.findOne({ groupId: group._id }).lean();
      const sorted = (standingsDoc?.standings || []).slice().sort(
        (a, b) =>
          (b.totalPoints || 0) - (a.totalPoints || 0)
          || (b.won || 0) - (a.won || 0)
          || (b.roundsWon || 0) - (a.roundsWon || 0)
      );
      let winner = null;
      if (sorted.length > 0) {
        winner = { playerId: sorted[0].playerId, userName: sorted[0].playerName };
      } else if (group.players && group.players.length > 0) {
        console.warn(
          `[identifySuperPlayers] No standings for group ${group._id} — falling back to first registered player.`
        );
        winner = group.players[0];
      }
      if (winner) {
        superPlayers.push({
          playerId: winner.playerId,
          playerName: winner.userName,
          category: group.category,
          sourceGroupId: group._id,
          sourceRound: 2,
          status: 'super_player',
        });
      }
    }

    // STEP 16e — sportId required at the boundary. Super Players are
    // tournament-level (not group-derived), so the caller must send
    // sportId explicitly.
    const _tournamentForSport = await Tournament.findById(tournamentId).lean();
    try {
      assertSportInTournament(req.body.sportId, _tournamentForSport);
    } catch (err) {
      if (handleSportContextError(err, res)) return;
      throw err;
    }
    const superPlayersDoc = new TopPlayers({
      tournamentId,
      sportId: req.body.sportId,
      groupId: 'round2_super_players',
      groupName: 'Super Players',
      players: superPlayers,
      round: 2,
      roundType: 'super_players'
    });

    await superPlayersDoc.save();

    // Update tournament stage (only the fields we need)
    await Tournament.findByIdAndUpdate(tournamentId, {
      currentStage: 'main_knockout',
      'stageConfig.qualifierKnockout.completed': true,
      'stageConfig.mainKnockout.enabled': true
    });

    return res.json({
      success: true,
      message: "Super Players identified successfully",
      superPlayers: superPlayers
    });

  } catch (error) {
    console.error("Error identifying Super Players:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

// Get Super Players
exports.getSuperPlayers = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { sportId } = req.query;

    // Multi-sport: strict sportId match. STEP 9d migration backfills
    // sportId on every SuperPlayers doc.
    const filter = sportId ? { tournamentId, sportId } : { tournamentId };
    const superPlayersDoc = await SuperPlayers.findOne(filter)
      .populate('players.playerId', 'name profileImage');

    if (!superPlayersDoc) {
      return res.json({
        success: true,
        superPlayers: []
      });
    }

    return res.json({
      success: true,
      superPlayers: superPlayersDoc.players
    });

  } catch (error) {
    console.error("Error fetching Super Players:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

// Reset Round 2 Progress
exports.resetRound2Progress = async (req, res) => {
  try {
    const { tournamentId, sportId } = req.body;

    // Multi-sport: when sportId is provided, scope all deletes to that sport
    // so a Tennis reset doesn't wipe Badminton's Round 2 data. BookingGroup
    // queries include sportId-null docs (pre-migration safety, mirrors
    // STEP 11a). Other collections use strict match (post-migration data).
    const groupFilter = sportId
      ? { tournamentId, round: 2, $or: [{ sportId }, { sportId: null }] }
      : { tournamentId, round: 2 };

    // Reset tournament stage back to group_stage. With sportId, write to
    // the per-sport track via setStageConfigPath/setCurrentStage; otherwise
    // legacy root-scalar reset.
    if (sportId) {
      const { setCurrentStage, setStageConfigPath } = require("../utils/sportTrackUtils");
      await setCurrentStage(tournamentId, sportId, 'group_stage');
      await setStageConfigPath(tournamentId, sportId, 'qualifierKnockout.enabled', false);
      await setStageConfigPath(tournamentId, sportId, 'qualifierKnockout.completed', false);
    } else {
      await Tournament.findByIdAndUpdate(tournamentId, {
        currentStage: 'group_stage',
        'stageConfig.qualifierKnockout.enabled': false,
        'stageConfig.qualifierKnockout.completed': false
      });
    }

    // Find Round 2 group IDs before deleting them (sport-scoped when sportId given).
    const round2Groups = await BookingGroup.find(groupFilter).select("_id");
    const round2GroupIds = round2Groups.map(g => g._id);

    // Delete matches belonging to Round 2 groups
    let deletedMatches = 0;
    if (round2GroupIds.length > 0) {
      const Match = require("../src/modules/tournaments/models/Tournnamentmatch");
      const matchFilter = sportId
        ? { tournamentId, sportId, groupId: { $in: round2GroupIds } }
        : { tournamentId, groupId: { $in: round2GroupIds } };
      const result = await Match.deleteMany(matchFilter);
      deletedMatches = result.deletedCount || 0;
    }

    // Delete Round 2 groups
    const groupResult = await BookingGroup.deleteMany(groupFilter);

    // Delete any Round 2 TopPlayers records (strict sportId match — TopPlayers
    // are post-migration writes via STEP 9c).
    const topPlayersFilter = sportId
      ? { tournamentId, sportId, round: 2 }
      : { tournamentId, round: 2 };
    await TopPlayers.deleteMany(topPlayersFilter);

    // Also delete DirectKnockoutMatch if Round 2 was knockout mode (strict).
    const DirectKnockoutMatch = require("../src/modules/tournaments/models/DirectKnockoutMatch");
    const dkFilter = sportId ? { tournamentId, sportId } : { tournamentId };
    const dkResult = await DirectKnockoutMatch.deleteMany(dkFilter);

    return res.json({
      success: true,
      message: sportId
        ? "Round 2 progress has been reset successfully for this sport"
        : "Round 2 progress has been reset successfully",
      deleted: {
        groups: groupResult.deletedCount || 0,
        matches: deletedMatches,
        knockoutMatches: dkResult.deletedCount || 0,
      }
    });

  } catch (error) {
    console.error("Error resetting Round 2 progress:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
};

// Normalize one category row from the wizard payload.
//
// Shared by createTournament and editTournament — the two used to carry
// identical copies of this mapping, which is how per-category fields get added
// to one path and forgotten on the other.
//
// The structural fields (type / groupStageFormat / knockoutFormat /
// qualifyPerGroup / drawSize) are per-category OVERRIDES: null means "inherit
// from the sport track", and that is what the resolvers in sportTrackUtils
// expect. An empty string from a <select> is therefore normalized to null, not
// persisted — otherwise it would fail the enum and, worse, read as an
// intentional override of the track value.
const CATEGORY_TYPES = ["knockout", "group stage", "knockout + group stage", "swiss"];
const GROUP_STAGE_FORMATS = ["Singles", "Doubles", "Teams"];
const KNOCKOUT_FORMATS = ["Singles", "Doubles", "Teams", "Teams Knockout", "Davis Cup"];
const DRAW_SIZES = [16, 32, 64];

// "YYYY-MM-DD" (or an ISO string starting with one) → "YYYY-MM-DD"; else null.
const toDayOrNull = (v) => {
  const m = typeof v === "string" ? v.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return m && !Number.isNaN(Date.parse(m[1])) ? m[1] : null;
};

// A category's day must fall inside the tournament's start–end range.
// Returns an error message, or null when every dated category fits.
const findCategoryDateOutOfRange = (sports, startDate, endDate) => {
  const start = toDayOrNull(startDate);
  const end = toDayOrNull(endDate);
  for (const s of sports || []) {
    for (const c of s.categories || []) {
      const day = toDayOrNull(c.date);
      if (!day) continue;
      if ((start && day < start) || (end && day > end)) {
        return `Category "${c.name}" (${s.sportName}) is dated ${day}, outside the tournament dates ${start || "?"} to ${end || "?"}.`;
      }
    }
  }
  return null;
};

const normalizeCategoryRow = (c) => {
  const toIntOrNull = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  // Only keep a value the schema enum accepts; anything else becomes null
  // (inherit) rather than throwing a validation error on save.
  const oneOf = (list, v) => (list.includes(v) ? v : null);

  const g = (c.gender || "any").toString().toLowerCase();
  const qualify = toIntOrNull(c.qualifyPerGroup);
  const draw = toIntOrNull(c.drawSize);

  return {
    templateId: c.templateId || null,
    name: c.name,
    fee: Number(c.fee || 0),
    minAge: toIntOrNull(c.minAge),
    maxAge: toIntOrNull(c.maxAge),
    gender: ["male", "female", "any"].includes(g) ? g : "any",
    date: toDayOrNull(c.date),

    // Per-category overrides — null everywhere means the track applies, which
    // is exactly how every tournament created before this behaved.
    type: oneOf(CATEGORY_TYPES, c.type),
    groupStageFormat: oneOf(GROUP_STAGE_FORMATS, c.groupStageFormat),
    knockoutFormat: oneOf(KNOCKOUT_FORMATS, c.knockoutFormat),
    // A cutoff has to be at least 1 to mean anything.
    qualifyPerGroup: qualify != null && qualify >= 1 ? qualify : null,
    drawSize: DRAW_SIZES.includes(draw) ? draw : null,
  };
};

/**
 * Stamp the server's scoringType onto a client-supplied matchFormat.
 *
 * The wizard computes scoringType and folds it into matchFormat, and this
 * controller used to persist that verbatim. When the web app's hardcoded
 * sport→scoringType table drifted from the server's, every tournament created
 * for the affected sport was saved with the wrong value — Carrom was stored as
 * "single" (one collapsed result) instead of "board" (scored board by board),
 * so the wrong scorer opened for the rest of the tournament's life.
 *
 * §6.1 already made the server the single source of that mapping and serves it
 * at GET /api/sports/scoring-config. Deriving it here as well means a stale or
 * hand-rolled client cannot reintroduce the drift.
 *
 * The client value is kept only when the server has no mapping — a custom sport
 * created on the fly, where getScoringType legitimately returns null.
 */
const withServerScoringType = (matchFormat, sportName) => {
  const serverType = getScoringType(sportName);
  if (!serverType) return matchFormat || null;
  return { ...(matchFormat || {}), scoringType: serverType };
};

//*Create Tournament*//

exports.createTournament = async (req, res) => {
  try {
    const {
      title,
      type,
      description,
      selectedTime,
      startDate,
      endDate,
      organizerName,
      cancellationPolicy,
      managerId,
      category,
      termsAndConditions,
      eventLocation, // ✅ simple string from frontend
      setNo,
      setsFormat,
      registrationDeadline,
      groupStageFormat,
      knockoutFormat,
      qualifyPerGroup,
      matchFormatOverrides, // Dynamic match format from sport-driven form
      turfIds, // For backward compatibility
      tournamentLevel, // district, state, national, international, unranked
      davisCupFormatId, // Team knockout format ID (e.g. "singles_bo5")
      drawSize, // Knockout bracket size (16, 32, 64)
      isPrivate, // Private/public visibility toggle
      clientId, // Custom client ID for private tournaments
      // Multi-sport payload (STEP 10a). When non-empty, this is the source of
      // truth — root scalars are derived from sports[0] for legacy compat.
      // May arrive as a JSON-encoded string when posted via multipart/form-data.
      sports,
    } = req.body;

    // STEP 16b — sports[] is now required at the API boundary. Reject
    // legacy single-sport payloads (sportsType + category, no sports[])
    // up front. Any payload that gets past this is multi-sport-shaped.
    let parsedSports;
    try {
      parsedSports = assertNonEmptySports(req.body);
    } catch (err) {
      if (handleSportContextError(err, res)) return;
      throw err;
    }

    const categoryDateError = findCategoryDateOutOfRange(parsedSports, startDate, endDate);
    if (categoryDateError) {
      return res.status(400).json({ message: categoryDateError });
    }

    // STEP 17c — root sportsType is no longer accepted from the
    // request body. Downstream lookups (sport rule book, match format
    // normalization, sanitize) read the primary sport name from
    // parsedSports[0].sportName.
    //
    // TODO: per-sport rule book lookup for multi-sport tournaments.
    // Currently only sports[0] gets a SportRuleBook auto-attached at
    // create time. Multi-sport tournaments with > 1 sport need each
    // sport's rule book resolved independently. Tracked as future work.
    const _primarySportName = parsedSports[0]?.sportName || null;

    // --- Basic validation ---
    // Per-sport `type` / groupStageFormat / knockoutFormat are validated by
    // assertNonEmptySports above (one check per sport entry). Root-level
    // checks were removed when those fields moved to per-sport in STEP 17c.
    if (!title) {
      return res.status(400).json({ message: "Title is required." });
    }

    // --- Parse turfIds (for backward compatibility) ---
    let parsedTurfIds = [];
    if (turfIds) {
      try {
        parsedTurfIds = typeof turfIds === "string" ? JSON.parse(turfIds) : turfIds;
        if (!Array.isArray(parsedTurfIds)) {
          throw new Error();
        }
      } catch {
        // Not critical since eventLocation is now a simple string
        parsedTurfIds = [];
      }
    }

    // --- Parse managerId ---
    // Accept both a real array (application/json) and a JSON-encoded string
    // (multipart/form-data) — mirrors how sports[] and matchFormatOverrides are
    // handled, so JSON-body create requests aren't rejected.
    let parsedManagerId = [];
    if (managerId) {
      try {
        parsedManagerId = typeof managerId === "string" ? JSON.parse(managerId) : managerId;
        if (!Array.isArray(parsedManagerId)) throw new Error();
      } catch {
        return res.status(400).json({ message: "Invalid managerId format" });
      }
    }
    // Ensure the creating manager always OWNS their tournament. The frontend
    // managerId list only carries staff the creator explicitly assigned, so
    // without this the creator is absent from managerId and gets locked out of
    // scoring/managing their own event (manager auth checks managerId membership).
    const creatorMgrId = req.user?._id?.toString() || req.user?.id?.toString();
    if ((req.userRole === "Manager" || req.accountType === "Manager") && creatorMgrId) {
      if (!parsedManagerId.some((id) => String(id) === creatorMgrId)) {
        parsedManagerId.push(creatorMgrId);
      }
    }

    // STEP 17c — root `category` parsing removed. Per-sport categories
    // are part of parsedSports[i].categories, validated by
    // assertNonEmptySports above.

    // --- Parse selectedTime (accept object [json] or JSON string [multipart]) ---
    let parsedSelectedTime = null;
    if (selectedTime) {
      try {
        parsedSelectedTime = typeof selectedTime === "string" ? JSON.parse(selectedTime) : selectedTime;
      } catch {
        return res.status(400).json({ message: "Invalid selectedTime format" });
      }
    }

    // --- Auto-attach locked sport rules from rule book ---
    // Per-sport level: each entry in parsedSports has its own tournamentLevel.
    // Root tournamentLevel is a legacy fallback for clients that haven't
    // migrated yet (the per-sport wizard sends per-sport, the legacy edit
    // modal sends root).
    const _sportZeroLevel = parsedSports[0]?.tournamentLevel || tournamentLevel || "district";
    // isUnranked drives the validateCustomRules branch below; sport[0] is
    // representative for that decision (validation runs against the primary
    // sport's overrides only).
    const isUnranked = _sportZeroLevel === "unranked";

    // Sub-step Plan A — per-sport rule book attachment.
    // For each sport: read its tournamentLevel (fall back to root for legacy
    // clients) and attach a frozen sportRules copy when ranked.
    const sportRulesBySportName = {};
    for (const s of parsedSports) {
      const perSportLevel = s.tournamentLevel || tournamentLevel || "district";
      if (perSportLevel === "unranked" || !s.sportName) continue;
      try {
        const rb = await SportRuleBook.findOne({
          sportName: { $regex: new RegExp(`^${escapeRegex(s.sportName)}$`, "i") },
          level: perSportLevel,
        }).lean();
        if (rb) {
          sportRulesBySportName[s.sportName] = {
            ruleBookId: rb._id,
            sportName: rb.sportName,
            level: rb.level,
            format: rb.format,
            rules: rb.rules,
            equipment: rb.equipment,
            isLocked: true,
          };
        }
      } catch (ruleErr) {
        console.log(`Rule book lookup skipped for ${s.sportName} @ ${perSportLevel}:`, ruleErr.message);
      }
    }
    // Legacy alias for downstream blocks that reference sportRulesData
    // (matchFormat normalize). Uses sports[0]'s entry.
    const sportRulesData = sportRulesBySportName[_primarySportName] || null;

    // --- Parse & validate dynamic matchFormatOverrides ---
    let parsedMatchFormatOverrides = null;
    if (matchFormatOverrides) {
      try {
        parsedMatchFormatOverrides = typeof matchFormatOverrides === "string"
          ? JSON.parse(matchFormatOverrides)
          : matchFormatOverrides;
      } catch {
        return res.status(400).json({ message: "Invalid matchFormatOverrides format" });
      }

      // Flatten nested sport-specific format structures into flat keys
      // The frontend ruleBook engine sends nested objects like { format: { oversCount: 20 }, scoring: {...} }
      // but the validator expects flat keys like { oversCount: 20 }
      const flattenOverrides = (obj) => {
        const flat = {};
        for (const [key, val] of Object.entries(obj)) {
          if (val && typeof val === "object" && !Array.isArray(val)) {
            // Recurse into nested objects, pull up known matchFormat keys
            const nested = flattenOverrides(val);
            Object.assign(flat, nested);
          } else {
            flat[key] = val;
          }
        }
        return flat;
      };
      parsedMatchFormatOverrides = flattenOverrides(parsedMatchFormatOverrides);

      // Backend safety: validate + sanitize against sport config
      if (_primarySportName) {
        const sportDoc = await Sport.findOne({
          name: { $regex: new RegExp(`^${escapeRegex(_primarySportName)}$`, "i") },
          isActive: true,
        }).lean();

        if (sportDoc) {
          const { valid, errors } = validateSportMatchFormat(parsedMatchFormatOverrides, sportDoc);
          if (!valid) {
            return res.status(400).json({
              message: "Match format validation failed",
              errors,
            });
          }
          // Strip any extra fields not relevant to this sport
          parsedMatchFormatOverrides = sanitizeMatchFormat(parsedMatchFormatOverrides, sportDoc);
        }
      }
    }

    // --- Build tournament object ---
    // --- SANITIZE overrides by sport type (strip irrelevant fields) ---
    let sanitizedOverrides = null;
    if (parsedMatchFormatOverrides) {
      sanitizedOverrides = sanitizeBySportType(_primarySportName, parsedMatchFormatOverrides);
    }

    // --- VALIDATE custom rules for unranked tournaments ---
    if (isUnranked && sanitizedOverrides) {
      const validation = validateCustomRules(_primarySportName, sanitizedOverrides);
      if (!validation.valid) {
        return res.status(400).json({
          message: "Custom rules validation failed",
          errors: validation.errors,
        });
      }
    }

    // --- NORMALIZE matchFormat (all derived fields computed server-side) ---
    // Used internally for the per-sport sports[0].matchFormat assignment
    // below; root tournament.matchFormat write removed in 17c.
    const computedMatchFormat = normalizeMatchFormat(
      _primarySportName,
      sanitizedOverrides,
      sportRulesData?.format
    );

    // STEP 17c — root scalar writes removed. Tournament.sports[] is the
    // canonical source. Only tournament-level metadata stays at root:
    // title, dates, manager, organizer, location, etc. Per-sport config
    // (type, sportsType, matchFormat, category, formats, qualifyPerGroup,
    // drawSize, sportRules, currentStage, stageConfig) is built into
    // tournamentData.sports below.
    const tournamentData = {
      title,
      // Root tournamentLevel kept for legacy MTournamentsList edit modal
      // and any consumers that read t.tournamentLevel. The canonical
      // per-sport value lives on each sports[i].tournamentLevel.
      tournamentLevel: _sportZeroLevel,
      // isCustomRules removed — was written every create but never read.
      // Derive on demand from sports.some(s => s.tournamentLevel === "unranked").
      description: description || "",
      selectedTime: parsedSelectedTime,
      startDate,
      endDate,
      organizerName,
      cancellationPolicy,
      eventLocation: eventLocation || "",
      managerId: parsedManagerId,
      termsAndConditions: termsAndConditions || "",
      registrationDeadline: registrationDeadline ? new Date(registrationDeadline) : null,
      isPrivate: isPrivate === "true" || isPrivate === true,
    };

    // --- Multi-sport: resolve each track's sportId and attach sports[] to
    // the tournamentData. Root scalars above were derived (by the frontend)
    // from sports[0] for legacy backward compat. Sport resolution: direct
    // lookup → fuzzy regex → placeholder Sport doc (mirrors the migration
    // script's behaviour so unresolved sport names don't block creation).
    {
      const SportModel = require("../src/modules/catalog/models/Sport");
      const slugify = (s) => String(s || "").toLowerCase().replace(/\s+/g, "_");
      const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const resolvedTracks = [];
      for (const s of parsedSports) {
        let sportDoc = await SportModel.findOne({ name: s.sportName }).lean();
        if (!sportDoc) {
          sportDoc = await SportModel.findOne({
            name: { $regex: new RegExp("^" + escapeRegex(s.sportName) + "$", "i") },
          }).lean();
        }
        if (!sportDoc) {
          const created = await SportModel.create({
            name: s.sportName,
            slug: slugify(s.sportName),
            category: "Custom",
            scoringType: s.matchFormat?.scoringType || "sets",
          });
          sportDoc = created.toObject ? created.toObject() : created;
        }
        const perSportLevel = s.tournamentLevel || tournamentLevel || "district";
        resolvedTracks.push({
          sportId: sportDoc._id,
          sportName: s.sportName,
          sportSlug: sportDoc.slug || slugify(s.sportName),
          tournamentLevel: perSportLevel,
          type: s.type || null,
          categories: s.categories.map(normalizeCategoryRow),
          formatScope: s.formatScope === "category" ? "category" : "sport",
          groupStageFormat: s.groupStageFormat || null,
          knockoutFormat: s.knockoutFormat || null,
          davisCupFormatId: s.davisCupFormatId || null,
          qualifyPerGroup: Number(s.qualifyPerGroup ?? 2),
          drawSize: s.drawSize ? Number(s.drawSize) : null,
          matchFormat: withServerScoringType(s.matchFormat, s.sportName),
          // Frozen rule-book copy resolved per-sport at attach time above.
          // Falls back to client-supplied s.sportRules for backward compat.
          sportRules: sportRulesBySportName[s.sportName] || s.sportRules || null,
          currentStage: "registration",
          stageConfig: {},
        });
      }
      tournamentData.sports = resolvedTracks;
    }

    // Generate or assign clientId for private tournaments
    if (tournamentData.isPrivate) {
      if (clientId && clientId.trim()) {
        tournamentData.clientId = clientId.trim().toUpperCase();
      } else {
        // Auto-generate: CK-{sport initials}-{random 6 chars}
        const sportPrefix = (_primarySportName || "SP").substring(0, 3).toUpperCase();
        const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
        tournamentData.clientId = `CK-${sportPrefix}-${rand}`;
      }
    }

    // --- Handle tournament logo upload ---
    if (req.file) {
      const uploadsDirPath = path.join(__dirname, "../uploads/tournaments");
      const relativePath = path.relative(uploadsDirPath, req.file.path);
      tournamentData.tournamentLogo = relativePath;
    }

    // --- Save tournament ---
    const newTournament = new Tournament(tournamentData);
    // Phase 5a finding: createTournament is a SINGLE-document write (one
    // Tournament). A single save is atomic on its own — wrapping it in a
    // transaction adds a replica-set requirement for zero benefit (and breaks
    // standalone Mongo). The genuinely multi-document tournament writes are the
    // group/match GENERATION endpoints; those are the real transaction targets.
    await newTournament.save();

    // STEP 16b — single-sport synthesis block removed; sports[] is now
    // built from `parsedSports` above and is always populated by save time.

    // --- Notify all players about new tournament ---
    try {
      const { notifyPlayers } = require("../utils/playerNotify");
      const User = require("../src/modules/identity/models/User");
      const allPlayers = await User.find({ role: "Player" }).select("_id").lean();
      const playerIds = allPlayers.map(p => p._id.toString());

      if (playerIds.length > 0) {
        // Don't await — fire and forget to not slow down response
        notifyPlayers(req.app, playerIds, {
          type: "tournament_new",
          title: `New Tournament — ${title}`,
          message: `${_primarySportName} tournament "${title}" is now open! ${eventLocation ? `📍 ${eventLocation}` : ""}`,
          data: {
            tournamentId: newTournament._id.toString(),
            tournamentName: title,
          },
        }).catch(err => console.error("[TOURNAMENT_NOTIFY] Error:", err.message));
      }
    } catch (notifErr) {
      console.error("[TOURNAMENT_NOTIFY] Error:", notifErr.message);
    }

    res.status(201).json({
      message: "Tournament created successfully",
      tournament: newTournament,
    });
  } catch (error) {
    console.error("Error creating tournament:", error);

    // --- Cleanup uploaded file if error ---
    if (req.file) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (cleanupErr) {
        console.error("Error deleting uploaded file:", cleanupErr);
      }
    }

    res.status(500).json({
      message: "Failed to create tournament",
      error: error.message,
    });
  }
};


exports.getTournamentById = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found",
      });
    }

    res.json({
      success: true,
      tournament,
    });
  } catch (error) {
    console.error("Error fetching tournament:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tournament details",
    });
  }
};

exports.getTournamentsByManager = async (req, res) => {
  try {
    const managerId = req.params.managerId;

    // Validate manager ID format
    if (!mongoose.Types.ObjectId.isValid(managerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid manager ID format",
      });
    }

    // 1. Get the manager to find their parent clubId
    const { Manager } = require("../src/modules/identity/models/ClubManager");
    const manager = await Manager.findById(managerId);

    const searchIds = [new mongoose.Types.ObjectId(managerId)];

    // If this manager belongs to a parent (Corporate Admin or Club Admin), 
    // also fetch tournaments created by that parent.
    if (manager && manager.clubId) {
      searchIds.push(new mongoose.Types.ObjectId(manager.clubId));
    }

    // 2. Find tournaments where managerId array contains either the manager's ID or their parent's ID
    const tournaments = await Tournament.find({
      managerId: { $in: searchIds },
    }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      tournaments,
      count: tournaments.length,
    });
  } catch (error) {
    console.error("Error fetching tournaments by manager:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tournaments",
    });
  }
};

exports.updateTournamentWhitelist = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { whitelist } = req.body;

    if (!Array.isArray(whitelist)) {
      return res.status(400).json({ success: false, message: "Whitelist must be an array" });
    }

    // Backend Unique Validation
    const uniqueIds = new Set();
    const uniqueMobiles = new Set();
    const validatedWhitelist = [];

    for (const emp of whitelist) {
      const { employeeId, mobile } = emp;

      // Basic check: if both ID and mobile are provided, check both. 
      // If only one is provided, check that one.
      const idKey = employeeId ? employeeId.toString().trim() : null;
      const mobileKey = mobile ? mobile.toString().trim() : null;

      if (idKey && uniqueIds.has(idKey)) {
        return res.status(400).json({ success: false, message: `Duplicate Employee ID found in list: ${idKey}` });
      }
      if (mobileKey && uniqueMobiles.has(mobileKey)) {
        return res.status(400).json({ success: false, message: `Duplicate Mobile number found in list: ${mobileKey}` });
      }

      if (idKey) uniqueIds.add(idKey);
      if (mobileKey) uniqueMobiles.add(mobileKey);

      validatedWhitelist.push(emp);
    }

    const Tournament = require("../src/modules/tournaments/models/Tournament");
    const tournament = await Tournament.findByIdAndUpdate(
      tournamentId,
      { whitelist: validatedWhitelist },
      { new: true }
    );

    if (!tournament) {
      return res.status(404).json({ success: false, message: "Tournament not found" });
    }

    res.status(200).json({
      success: true,
      message: "Employee whitelist updated successfully",
      tournament
    });
  } catch (error) {
    console.error("Error updating whitelist:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update whitelist"
    });
  }
};

exports.getTournamentsByCorporate = async (req, res) => {
  try {
    const { corporateId } = req.params;

    // 1. Find all managers belonging to this Corporate Admin
    const { Manager } = require("../src/modules/identity/models/ClubManager");
    const managers = await Manager.find({ clubId: corporateId });

    // Extract manager IDs
    const searchIds = managers.map(m => m._id);

    // 2. Add the corporateId itself to include tournaments created by the Corporate Admin
    if (mongoose.Types.ObjectId.isValid(corporateId)) {
      searchIds.push(new mongoose.Types.ObjectId(corporateId));
    }

    // 3. Find tournaments created by these managers or the corporate admin themselves
    const tournaments = await Tournament.find({
      managerId: { $in: searchIds }
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      tournaments
    });

  } catch (error) {
    console.error("Error fetching corporate tournaments:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch corporate tournaments"
    });
  }
};

exports.getAllTournaments = async (req, res) => {
  try {
    // Exclude private tournaments from public listing (mobile app)
    // Manager/corporate dashboards use their own endpoints which return all
    const includePrivate = req.query.includePrivate === "true";
    const filter = includePrivate ? {} : { isPrivate: { $ne: true } };

    // Pagination — default 20 per page, hard-capped at 100 so a client can't
    // ask for the entire collection. Previously this returned EVERY tournament
    // to every mobile client on app open.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [tournaments, total] = await Promise.all([
      Tournament.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Tournament.countDocuments(filter),
    ]);

    // Pagination metadata in headers so existing clients that expect a bare
    // array keep working unchanged (they just receive ≤limit items).
    res.set("X-Total-Count", String(total));
    res.set("X-Page", String(page));
    res.set("X-Limit", String(limit));
    res.set("X-Total-Pages", String(Math.ceil(total / limit) || 1));
    res.status(200).json(tournaments);
  } catch (error) {
    console.error("Error fetching tournaments:", error.message);
    res.status(500).json({
      message: "Failed to retrieve tournaments",
      error: error.message,
    });
  }
};

exports.deleteTournament = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ message: "Invalid tournament id" });
  }

  // Every related collection keyed by tournamentId. Deleting a tournament must
  // remove ALL of these — previously only Booking + BookingGroup were deleted,
  // orphaning matches, scores, payments and standings. Models that don't have a
  // tournamentId field simply match nothing (harmless).
  const RELATED_MODELS = [
    Booking,
    BookingGroup,
    Score,
    Match,                 // Tournnamentmatch (group-stage matches)
    KnockoutMatch,
    DirectKnockoutMatch,
    SuperMatch,
    TeamKnockout,
    TeamKnockoutMatches,
    TeamKnockoutTeams,
    GroupStandings,
    TopPlayers,
    SuperPlayers,
    PlayerPayment,
  ];

  const session = await mongoose.startSession();
  try {
    let found = false;
    await session.withTransaction(async () => {
      const tournament = await Tournament.findByIdAndDelete(id, { session });
      if (!tournament) return; // leave found=false → 404 below (txn commits with no deletes)
      found = true;

      const filter = { tournamentId: id };
      // Sequential (NOT Promise.all) — a single session is not safe for
      // concurrent operations within a transaction.
      for (const Model of RELATED_MODELS) {
        await Model.deleteMany(filter, { session });
      }
    });

    if (!found) {
      return res.status(404).json({ message: "Tournament not found" });
    }
    return res.status(200).json({
      message: "Tournament and all related data deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting tournament and related data:", error);
    return res.status(500).json({
      message: "Failed to delete tournament and related data",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

exports.editTournament = async (req, res) => {
  try {
    const { id } = req.params;

    const tournament = await Tournament.findById(id);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // ═══ LOCKED FIELDS AFTER TOURNAMENT STARTS ═══
    // After registration ends, format-shape fields cannot be modified
    // (they would break already-generated matches, brackets, groups).
    //
    // STEP 17c — the 6 deprecated root scalars (sportsType, type,
    // groupStageFormat, knockoutFormat, davisCupFormatId, drawSize)
    // were removed from this list — controller stops writing them
    // entirely below, so the strip is moot. matchFormatOverrides stays
    // because it's still a transient form field that drives
    // sports[i].matchFormat normalization on edit.
    //
    // sports[]-level format changes are guarded separately by the 409
    // downstream-data check inside the isMultiSportEdit block.
    const LOCKED_FIELDS = ["matchFormatOverrides"];
    // STEP 17c — read currentStage off sports[0] (root scalar gone).
    const { getCurrentStage } = require("../utils/sportTrackUtils");
    const hasStarted = getCurrentStage(tournament) !== "registration"
      && getCurrentStage(tournament) !== null;

    if (hasStarted) {
      const strippedFields = [];
      for (const f of LOCKED_FIELDS) {
        if (req.body[f] !== undefined) {
          delete req.body[f];
          strippedFields.push(f);
        }
      }
      if (strippedFields.length > 0) {
        console.warn(
          `[editTournament] Tournament ${id} (stage=${getCurrentStage(tournament)}) — ignored locked fields: ${strippedFields.join(", ")}`
        );
      }
    }

    // Parse selectedTime
    let parsedSelectedTime = tournament.selectedTime;
    if (req.body.selectedTime) {
      try {
        parsedSelectedTime = typeof req.body.selectedTime === "string"
          ? JSON.parse(req.body.selectedTime)
          : req.body.selectedTime;
        if (
          typeof parsedSelectedTime !== "object" ||
          !parsedSelectedTime.startTime ||
          !parsedSelectedTime.endTime
        ) {
          return res.status(400).json({ message: "Invalid selectedTime format" });
        }
      } catch (err) {
        return res.status(400).json({ message: "Invalid selectedTime format" });
      }
    }

    // STEP 17c — root `category` parsing removed. Per-sport categories
    // are part of req.body.sports[i].categories, validated by
    // assertNonEmptySports inside the sports[] block below.

    // Parse terms and conditions
    let termsAndConditions = req.body.termsAndConditions || tournament.termsAndConditions;

    // Parse managerId
    let managerIds = tournament.managerId;
    if (req.body.managerId) {
      try {
        managerIds = typeof req.body.managerId === "string"
          ? JSON.parse(req.body.managerId)
          : req.body.managerId;
        if (!Array.isArray(managerIds)) {
          return res.status(400).json({ message: "Invalid managerId format" });
        }
      } catch (err) {
        return res.status(400).json({ message: "Invalid managerId format" });
      }
    }

    // Handle logo upload
    if (req.file) {
      const uploadsDir = path.join(__dirname, "../uploads/tournaments");
      const relativePath = path.relative(uploadsDir, req.file.path);
      tournament.tournamentLogo = relativePath;
    }

    // Update SAFE fields (allowed at any stage). Tournament-level metadata
    // only — per-sport config is updated via the sports[] block below.
    tournament.title = req.body.title || tournament.title;
    tournament.description = req.body.description || tournament.description;
    tournament.selectedTime = parsedSelectedTime;
    tournament.startDate = req.body.startDate || tournament.startDate;
    tournament.endDate = req.body.endDate || tournament.endDate;
    tournament.organizerName = req.body.organizerName || tournament.organizerName;
    tournament.cancellationPolicy = req.body.cancellationPolicy || tournament.cancellationPolicy;
    tournament.eventLocation = req.body.eventLocation || tournament.eventLocation;
    tournament.managerId = managerIds;
    tournament.termsAndConditions = termsAndConditions;
    // Present-but-empty clears the deadline; absent leaves it untouched.
    if (req.body.registrationDeadline !== undefined) {
      const d = req.body.registrationDeadline ? new Date(req.body.registrationDeadline) : null;
      if (d && Number.isNaN(d.getTime())) {
        return res.status(400).json({ message: "Invalid registration deadline" });
      }
      tournament.registrationDeadline = d;
    }

    // Privacy + clientId. multipart/form-data sends booleans as strings —
    // accept both "true"/"false" and real booleans. When toggling to private,
    // honor a client-supplied clientId; auto-generate one if absent and the
    // tournament didn't already have one. When toggling to public, leave
    // the existing clientId in place (sparse-unique index allows it to
    // remain attached to a public tournament harmlessly, and preserves
    // history if the manager flips back).
    if (req.body.isPrivate !== undefined) {
      const wantsPrivate = req.body.isPrivate === "true" || req.body.isPrivate === true;
      tournament.isPrivate = wantsPrivate;
      if (wantsPrivate) {
        if (req.body.clientId && req.body.clientId.trim()) {
          tournament.clientId = req.body.clientId.trim().toUpperCase();
        } else if (!tournament.clientId) {
          const sportPrefix = (tournament.sports?.[0]?.sportName || "SP")
            .substring(0, 3).toUpperCase();
          const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
          tournament.clientId = `CK-${sportPrefix}-${rand}`;
        }
      }
    }

    // STEP 17c — root scalar writes removed. The fields type, sportsType,
    // groupStageFormat, knockoutFormat, davisCupFormatId, drawSize,
    // qualifyPerGroup, category, setFormat, matchFormat are now per-sport
    // and updated via the sports[] block below. Frontend may still send
    // these as FormData (forward-compat) — they're silently ignored.

    // STEP 11d — Multi-sport edit: when req.body.sports is provided as a
    // non-empty array, full-replace tournament.sports (with a 409
    // downstream-data guard for removed sports). Per approval fix #2 the
    // sports[] replace happens BEFORE we mirror sports[0] back to root, so
    // root scalars reflect the NEW sports[0] (not a removed one).
    // STEP 16b — when sports[] is present in the request body, validate
    // it via the shared helper. If absent (legitimate title/date-only
    // edit), leave existing tournament.sports untouched. Empty arrays
    // are rejected — mid-flight tournaments must keep at least one
    // sport (the 409 downstream-data guard further below also enforces
    // that removed sports have no live data).
    let isMultiSportEdit = false;
    let parsedSportsForEdit = [];
    if (req.body.sports !== undefined && req.body.sports !== null && req.body.sports !== "") {
      try {
        parsedSportsForEdit = assertNonEmptySports(req.body);
        isMultiSportEdit = true;
      } catch (err) {
        if (handleSportContextError(err, res)) return;
        throw err;
      }

      // tournament.startDate/endDate already hold this request's values (set above).
      const categoryDateError = findCategoryDateOutOfRange(parsedSportsForEdit, tournament.startDate, tournament.endDate);
      if (categoryDateError) {
        return res.status(400).json({ message: categoryDateError });
      }
    }

    if (isMultiSportEdit) {
      const SportModelMS = require("../src/modules/catalog/models/Sport");
      const slugifyMS = (s) => String(s || "").toLowerCase().replace(/\s+/g, "_");
      const escapeRegexMS = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Resolve sportId for each new entry (cache → fuzzy → placeholder).
      const resolvedTracks = [];
      for (const s of parsedSportsForEdit) {
        let sportDoc = await SportModelMS.findOne({ name: s.sportName }).lean();
        if (!sportDoc) {
          sportDoc = await SportModelMS.findOne({
            name: { $regex: new RegExp("^" + escapeRegexMS(s.sportName) + "$", "i") },
          }).lean();
        }
        if (!sportDoc) {
          const created = await SportModelMS.create({
            name: s.sportName,
            slug: slugifyMS(s.sportName),
            category: "Custom",
            scoringType: s.matchFormat?.scoringType || "sets",
          });
          sportDoc = created.toObject ? created.toObject() : created;
        }
        // Per-sport tournamentLevel — falls back to legacy root for clients
        // that haven't migrated. On edit-load of a legacy tournament, the
        // root field carries the previous level forward to each sport entry.
        const perSportLevel = s.tournamentLevel || tournament.tournamentLevel || "district";

        // Per-sport rule book attach for edit (mirror of create-time logic).
        let editSportRules = s.sportRules || null;
        if (perSportLevel !== "unranked" && s.sportName) {
          try {
            const rb = await SportRuleBook.findOne({
              sportName: { $regex: new RegExp(`^${escapeRegex(s.sportName)}$`, "i") },
              level: perSportLevel,
            }).lean();
            if (rb) {
              editSportRules = {
                ruleBookId: rb._id,
                sportName: rb.sportName,
                level: rb.level,
                format: rb.format,
                rules: rb.rules,
                equipment: rb.equipment,
                isLocked: true,
              };
            }
          } catch (ruleErr) {
            console.log(`Edit rule book lookup skipped for ${s.sportName} @ ${perSportLevel}:`, ruleErr.message);
          }
        }

        resolvedTracks.push({
          sportId: sportDoc._id,
          sportName: s.sportName,
          sportSlug: sportDoc.slug || slugifyMS(s.sportName),
          tournamentLevel: perSportLevel,
          type: s.type || null,
          categories: s.categories.map(normalizeCategoryRow),
          formatScope: s.formatScope === "category" ? "category" : "sport",
          groupStageFormat: s.groupStageFormat || null,
          knockoutFormat: s.knockoutFormat || null,
          davisCupFormatId: s.davisCupFormatId || null,
          qualifyPerGroup: Number(s.qualifyPerGroup ?? 2),
          drawSize: s.drawSize ? Number(s.drawSize) : null,
          matchFormat: withServerScoringType(s.matchFormat, s.sportName),
          sportRules: editSportRules,
          currentStage: s.currentStage || "registration",
          stageConfig: s.stageConfig || {},
        });
      }

      // 409 downstream-data check — runs across Match / KnockoutMatch /
      // SuperMatch / DirectKnockoutMatch / BookingGroup / TopPlayers per
      // STEP 11d approval fix #3. Returns immediately on first conflict
      // with detailed counts.
      const existingSportIds = (tournament.sports || [])
        .map((s) => String(s.sportId || ""))
        .filter(Boolean);
      const newSportIds = new Set(resolvedTracks.map((t) => String(t.sportId)));
      const removedSportIds = existingSportIds.filter((id) => !newSportIds.has(id));

      if (removedSportIds.length > 0) {
        const MatchM = require("../src/modules/tournaments/models/Tournnamentmatch");
        const KnockoutMatchM = require("../src/modules/tournaments/models/KnockoutMatch");
        const SuperMatchM = require("../src/modules/tournaments/models/SuperMatch");
        const DirectKnockoutMatchM = require("../src/modules/tournaments/models/DirectKnockoutMatch");
        const BookingGroupM = require("../src/modules/tournaments/models/bookinggroup");

        for (const removedId of removedSportIds) {
          const [matches, kos, superMs, dks, bgs, tps] = await Promise.all([
            MatchM.countDocuments({ tournamentId: id, sportId: removedId }),
            KnockoutMatchM.countDocuments({ tournamentId: id, sportId: removedId }),
            SuperMatchM.countDocuments({ tournamentId: id, sportId: removedId }),
            DirectKnockoutMatchM.countDocuments({ tournamentId: id, sportId: removedId }),
            // BookingGroup uses include-null per STEP 11a pattern.
            BookingGroupM.countDocuments({
              tournamentId: id,
              $or: [{ sportId: removedId }, { sportId: null }],
            }),
            TopPlayers.countDocuments({ tournamentId: id, sportId: removedId }),
          ]);
          const total = matches + kos + superMs + dks + bgs + tps;
          if (total > 0) {
            const removedSportName = (tournament.sports || [])
              .find((t) => String(t.sportId) === String(removedId))?.sportName || "this sport";
            return res.status(409).json({
              success: false,
              message: `Cannot remove "${removedSportName}" — it has downstream data (${matches} matches, ${kos} knockout matches, ${superMs} super matches, ${dks} direct-KO matches, ${bgs} groups, ${tps} top players). Reset Round 2 for this sport first.`,
              conflicts: {
                sportId: removedId,
                sportName: removedSportName,
                matches,
                knockoutMatches: kos,
                superMatches: superMs,
                directKnockoutMatches: dks,
                bookingGroups: bgs,
                topPlayers: tps,
              },
            });
          }
        }
      }

      // STEP 17c — replace sports[]; root scalar mirror REMOVED.
      // sports[i] is the canonical source. Frontend reads via per-sport
      // helpers post-17b — no consumer of root sportsType/type/etc.
      tournament.sports = resolvedTracks;
      tournament.markModified("sports");
    }

    // STEP 17c — single-sport sync fallback REMOVED. Edits that don't
    // include req.body.sports skip the sports[] write entirely (only
    // tournament-level metadata like title/dates updates). Use the
    // multi-sport edit payload to update per-sport config.

    // validateModifiedOnly: only re-validate fields this request actually changed.
    // Protects against existing legacy/out-of-enum values on untouched fields (e.g.,
    // a tournament stored with currentStage="qualifier_knockout" from older code paths).
    await tournament.save({ validateModifiedOnly: true });

    res.status(200).json({
      message: "Tournament updated successfully",
      tournament,
    });
  } catch (error) {
    console.error("Error updating tournament:", error);
    if (req.file) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (unlinkErr) {
        console.error("Error removing uploaded file after failure:", unlinkErr);
      }
    }
    res.status(500).json({
      message: "Failed to update tournament",
      error: error.message,
    });
  }
};



exports.createScore = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { playerA, playerB, setOne, setTwo, setThree } = req.body;

    if (!playerA || !playerB || !setOne) {
      return res.status(400).json({
        message: "Missing required fields",
        received: { playerA, playerB, setOne, setTwo, setThree },
      });
    }

    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: "Match not found" });
    }

    const playerIdsInMatch = [
      match.player1.toString(),
      match.player2.toString(),
    ];

    if (!playerIdsInMatch.includes(playerA) || !playerIdsInMatch.includes(playerB)) {
      return res.status(400).json({
        message: "Players must belong to the match",
        validPlayers: playerIdsInMatch,
      });
    }

    // ✅ Helper: validate a set (≥11 points & 2-point lead)
    const isValidSet = (score) => {
      if (!score || typeof score !== "string" || !score.includes("-")) return false;
      const [a, b] = score.split("-").map(Number);
      if (isNaN(a) || isNaN(b)) return false;
      return (a >= 11 || b >= 11) && Math.abs(a - b) >= 2;
    };

    // ✅ Collect sets that exist
    const sets = [setOne, setTwo, setThree].filter(Boolean);

    // Validate each set
    if (!sets.every(isValidSet)) {
      return res.status(400).json({ message: "Invalid set scores. Each set must have ≥11 points and a 2-point lead." });
    }

    // ✅ Count set wins
    let playerAWins = 0, playerBWins = 0;
    sets.forEach((set) => {
      const [a, b] = set.split("-").map(Number);
      if (a > b) playerAWins++;
      if (b > a) playerBWins++;
    });

    // ✅ Derive winner from set wins
    let winner = null;
    if (playerAWins > playerBWins) {
      winner = playerA;
    } else if (playerBWins > playerAWins) {
      winner = playerB;
    }

    if (!winner) {
      return res.status(400).json({ message: "Could not determine a winner from set results" });
    }

    const newScore = new Score({
      matchId,
      playerA,
      playerB,
      setOne,
      setTwo: setTwo || null,
      setThree: setThree || null,
      winner,
    });

    await newScore.save();

    res.status(201).json({
      message: "Score saved successfully",
      newScore,
    });
  } catch (error) {
    console.error("Error creating score:", error);
    res.status(500).json({
      message: "Failed to save score",
      error: error.message,
    });
  }
};

exports.getScoreByMatchId = async (req, res) => {
  try {
    const { matchId } = req.params;

    const score = await Score.findOne({ matchId })
      .populate({
        path: 'playerA',
        populate: {
          path: 'userId',
          select: 'name profileImage',
        },
      })
      .populate({
        path: 'playerB',
        populate: {
          path: 'userId',
          select: 'name profileImage',
        },
      })
      .populate({
        path: 'winner',
        populate: {
          path: 'userId',
          select: 'name profileImage',
        },
      });

    if (!score) {
      return res.status(404).json({ message: "Score not found for this match" });
    }

    res.status(200).json({ score });
  } catch (error) {
    console.error("Error fetching score:", error);
    res.status(500).json({
      message: "Failed to fetch score",
      error: error.message,
    });
  }
};

exports.updateScoreByMatchId = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { playerA, playerB, setOne, setTwo, setThree, winner } = req.body;

    if (!playerA || !playerB || !setOne || !setTwo || !winner) {
      return res.status(400).json({
        message: "Missing required fields",
        received: { playerA, playerB, setOne, setTwo, setThree, winner },
      });
    }

    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: "Match not found" });
    }

    const playerIdsInMatch = [
      match.player1.toString(),
      match.player2.toString(),
    ];

    if (!playerIdsInMatch.includes(playerA) || !playerIdsInMatch.includes(playerB)) {
      return res.status(400).json({
        message: "Players must belong to the match",
        validPlayers: playerIdsInMatch,
      });
    }

    if (![playerA, playerB].includes(winner)) {
      return res.status(400).json({ message: "Winner must be one of the two players" });
    }

    const isValidScore = (score) => {
      let a, b;
      if (Array.isArray(score)) {
        [a, b] = score;
      } else if (typeof score === "string" && score.includes("-")) {
        [a, b] = score.split("-").map(Number);
      }
      return typeof a === 'number' && typeof b === 'number' && (a >= 11 || b >= 11);
    };

    if (![setOne, setTwo].every(isValidScore) || (setThree && !isValidScore(setThree))) {
      return res.status(400).json({
        message: "Each set must have at least 11 points by any player",
      });
    }

    const updatedScore = await Score.findOneAndUpdate(
      { matchId },
      {
        playerA,
        playerB,
        setOne,
        setTwo,
        setThree,
        winner,
      },
      { new: true }
    );

    if (!updatedScore) {
      return res.status(404).json({ message: "Score not found for this match" });
    }

    res.status(200).json({
      message: "Score updated successfully",
      updatedScore,
    });
  } catch (error) {
    console.error("Error updating score:", error);
    res.status(500).json({
      message: "Failed to update score",
      error: error.message,
    });
  }
};

exports.deleteScoreByMatchId = async (req, res) => {
  try {
    const { matchId } = req.params;

    const deleted = await Score.findOneAndDelete({ matchId });

    if (!deleted) {
      return res.status(404).json({ message: "Score not found for this match" });
    }

    res.status(200).json({
      message: "Score deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting score:", error);
    res.status(500).json({
      message: "Failed to delete score",
      error: error.message,
    });
  }
};

exports.getScoresByMatchIdArray = async (req, res) => {
  try {
    const { matchId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json([]);
    }

    // Fetch all scores for this match (latest first)
    const scores = await Score.find({ matchId }).sort({ createdAt: -1 });

    // Fetch match to get detailed player info
    const match = await Match.findById(matchId)
      .populate('player1.playerId', 'name userName profileImage')
      .populate('player2.playerId', 'name userName profileImage');

    if (!match) {
      return res.status(404).json([]);
    }

    // Extract player information with fallbacks
    const player1Id = match.player1?.playerId?._id?.toString() || match.player1?.playerId?.toString();
    const player2Id = match.player2?.playerId?._id?.toString() || match.player2?.playerId?.toString();

    const player1Name = match.player1?.playerId?.userName ||
      match.player1?.playerId?.name ||
      match.player1?.userName ||
      'Player 1';
    const player2Name = match.player2?.playerId?.userName ||
      match.player2?.playerId?.name ||
      match.player2?.userName ||
      'Player 2';

    if (scores.length === 0) {
      return res.status(200).json([]);
    }

    // Transform scores with enhanced data processing
    const transformedScores = scores.map((score, idx) => {

      // Smart set conversion - handles both string and array formats
      const convertSetToArray = (setData) => {
        if (!setData) return [0, 0];

        if (Array.isArray(setData)) {
          return setData.length >= 2 ? [parseInt(setData[0]) || 0, parseInt(setData[1]) || 0] : [0, 0];
        }

        if (typeof setData === 'string' && setData.includes('-')) {
          const parts = setData.split('-').map(s => parseInt(s.trim()) || 0);
          return parts.length >= 2 ? [parts[0], parts[1]] : [0, 0];
        }

        return [0, 0];
      };

      // Enhanced player name mapping
      let playerAName = 'Unknown Player A';
      let playerBName = 'Unknown Player B';

      // Map playerA
      if (score.playerA === player1Id) {
        playerAName = player1Name;
      } else if (score.playerA === player2Id) {
        playerAName = player2Name;
      }

      // Map playerB
      if (score.playerB === player1Id) {
        playerBName = player1Name;
      } else if (score.playerB === player2Id) {
        playerBName = player2Name;
      }

      // Enhanced transformed score object
      const transformed = {
        _id: score._id,
        matchId: score.matchId,
        playerA: score.playerA,
        playerB: score.playerB,
        playerAName,
        playerBName,

        // Set scores in array format for frontend compatibility
        setOne: convertSetToArray(score.setOne),
        setTwo: convertSetToArray(score.setTwo),
        setThree: score.setThree ? convertSetToArray(score.setThree) : null,

        // Enhanced match statistics - directly from Score record
        gamesWonA: score.gamesWonA !== undefined ? score.gamesWonA : 0,
        gamesWonB: score.gamesWonB !== undefined ? score.gamesWonB : 0,
        totalScoreA: score.totalScoreA !== undefined ? score.totalScoreA : 0,
        totalScoreB: score.totalScoreB !== undefined ? score.totalScoreB : 0,

        // Match outcome
        winner: score.winner,
        matchStatus: score.matchStatus || 'COMPLETED',

        // Metadata
        createdAt: score.createdAt,
        updatedAt: score.updatedAt
      };
      return transformed;
    });

    return res.status(200).json(transformedScores);

  } catch (error) {
    console.error("❌ Error in getScoresByMatchIdArray:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch match scores",
      error: error.message,
      scores: [] // Return empty array for graceful frontend handling
    });
  }
};



// exports.getScoresByMatchIdArray = async (req, res) => {
//   try {
//     const { matchId } = req.params;
//     console.log(`Fetching scores for match: ${matchId}`);

//     // Get scores from Score model only (completed matches should be synced here)
//     // Populate player data to get names for points table
//     const scores = await Score.find({ matchId }).sort({ createdAt: -1 });

//     if (scores && scores.length > 0) {
//       console.log(`Found ${scores.length} scores in Score model`);

//       // Get the match to access player information
//       const match = await Match.findById(matchId)
//         .populate('player1.playerId', 'name userName')
//         .populate('player2.playerId', 'name userName');

//       // Transform scores to match frontend expectations and add player names
//       const transformedScores = scores.map(score => {
//         const convertSetToArray = (setStr) => {
//           if (!setStr) return null;
//           return setStr.split('-').map(num => parseInt(num, 10));
//         };

//         // Add player name information for points table
//         let playerAName = 'Unknown Player';
//         let playerBName = 'Unknown Player';

//         if (match) {
//           // Find which player corresponds to playerA and playerB in the score
//           const player1Id = match.player1.playerId?._id?.toString() || match.player1.playerId?.toString();
//           const player2Id = match.player2.playerId?._id?.toString() || match.player2.playerId?.toString();

//           if (score.playerA === player1Id) {
//             playerAName = match.player1.playerId?.userName || match.player1.playerId?.name || match.player1.userName || 'Player 1';
//           } else if (score.playerA === player2Id) {
//             playerAName = match.player2.playerId?.userName || match.player2.playerId?.name || match.player2.userName || 'Player 2';
//           }

//           if (score.playerB === player1Id) {
//             playerBName = match.player1.playerId?.userName || match.player1.playerId?.name || match.player1.userName || 'Player 1';
//           } else if (score.playerB === player2Id) {
//             playerBName = match.player2.playerId?.userName || match.player2.playerId?.name || match.player2.userName || 'Player 2';
//           }
//         }

//         return {
//           ...score.toObject(),
//           setOne: convertSetToArray(score.setOne),
//           setTwo: convertSetToArray(score.setTwo),
//           setThree: score.setThree ? convertSetToArray(score.setThree) : null,
//           playerAName, // Add player names for frontend display
//           playerBName,
//           // DOCX Requirements: Include comprehensive statistics
//           gamesWonA: score.gamesWonA || 0,
//           gamesWonB: score.gamesWonB || 0,
//           totalScoreA: score.totalScoreA || 0,
//           totalScoreB: score.totalScoreB || 0
//         };
//       });
//       return res.status(200).json(transformedScores);
//     }

//     // No scores found - this means completed matches haven't been synced yet
//     console.log('No scores found in Score model. If match is completed, it needs to be synced.');
//     return res.status(200).json([]);

//   } catch (error) {
//     console.error("Error fetching scores array:", error);
//     res.status(500).json({
//       message: "Failed to fetch scores",
//       error: error.message,
//     });
//   }
// };

exports.saveTopPlayers = async (req, res) => {
  try {
    const { tournamentId, groupId, groupName, topPlayers, players } = req.body;

    if (!tournamentId || !groupId) {
      return res.status(400).json({
        success: false,
        message: "Tournament ID and Group ID are required",
      });
    }

    // Handle seeded players format (players) or existing top players format (topPlayers)
    let formattedTopPlayers = [];

    if (players && Array.isArray(players) && players.length > 0) {
      // Store in both legacy and new format for compatibility
      formattedTopPlayers = players
        .filter(player => player.playerId || player.id || player._id) // Filter out invalid entries
        .map(player => ({
          playerId: player.playerId || player._id || player.id,
          playerName: player.playerName || player.name || player.userName || "Unknown Player",
          userName: player.playerName || player.name || player.userName || "Unknown Player",
          category: player.category || 'Open',
          points: 0, // Default points for seeded players
          setsWon: 0,
          setsLost: 0,
          won: 0,
          lost: 0,
          played: 0,
          status: 'top_player',
          sourceRound: 1
        }));
    } else if (topPlayers && Array.isArray(topPlayers)) {
      // Use existing top players format
      formattedTopPlayers = topPlayers.filter(player => player.playerId || player._id);
    } else {
      console.log("Empty or invalid players list, proceeding to clear group if needed.");
      // ALLOW empty list to clear the group choice!
    }

    // STEP 16e — derive sportId from the BookingGroup when groupId is
    // a real ObjectId. groupId may also be a synthetic string like
    // "seeded_<sportSlug>_<categorySlug>" — for those, require
    // explicit req.body.sportId since there's no parent group to
    // inherit from.
    //
    // Order matters: this MUST run before the duplicate-player check below
    // so that check can scope to (tournamentId, sportId). A player is allowed
    // to be a top player in multiple sports (one entry per sport) — only
    // within-sport duplicates are an error.
    const _tournament = await Tournament.findById(tournamentId).lean();
    let _sportId;
    let _maybeGroup = null;
    if (mongoose.Types.ObjectId.isValid(groupId)) {
      _maybeGroup = await BookingGroup.findById(groupId).lean();
    }
    try {
      if (_maybeGroup) {
        _sportId = assertGroupHasSport(_maybeGroup);
      } else {
        // Synthetic / non-ObjectId groupId — fall back to explicit body.
        assertSportInTournament(req.body.sportId, _tournament);
        _sportId = req.body.sportId;
      }
    } catch (err) {
      if (handleSportContextError(err, res)) return;
      throw err;
    }

    // 🚀 DUPLICATE PLAYER VALIDATION (sport-scoped)
    // A player can only be a Top Player in ONE group per sport. Cross-sport
    // overlap is allowed — same person can compete in Badminton and Table
    // Tennis brackets independently. Scoping by sportId here means we only
    // block within-sport duplicates.
    const existingTopPlayersInTournament = await TopPlayers.find({
      tournamentId,
      sportId: _sportId,
      groupId: { $ne: groupId } // Exclude current group
    });

    // Flatten all existing players from other groups (within the same sport)
    const existingPlayerIds = new Set();
    const existingPlayerNames = new Map(); // Map playerId -> { name, groupName }

    existingTopPlayersInTournament.forEach(groupDoc => {
      const playersList = (groupDoc.players && groupDoc.players.length > 0) ? groupDoc.players : groupDoc.topPlayers;
      if (playersList && Array.isArray(playersList)) {
        playersList.forEach(p => {
          const pid = p.playerId || p._id;
          if (pid) {
            const pidStr = pid.toString();
            existingPlayerIds.add(pidStr);
            if (!existingPlayerNames.has(pidStr)) {
              existingPlayerNames.set(pidStr, {
                name: p.playerName || p.userName || "Unknown",
                groupName: groupDoc.groupName
              });
            }
          }
        });
      }
    });

    // Check for duplicates in the new players being added
    const duplicatePlayers = [];
    formattedTopPlayers.forEach(player => {
      const pid = player.playerId;
      if (pid) {
        const pidStr = pid.toString();
        if (existingPlayerIds.has(pidStr)) {
          const existingInfo = existingPlayerNames.get(pidStr);
          duplicatePlayers.push({
            playerName: player.playerName,
            existingGroup: existingInfo ? existingInfo.groupName : "another group"
          });
        }
      }
    });

    // If duplicates found, reject the request
    if (duplicatePlayers.length > 0) {
      const duplicateList = duplicatePlayers.map(p =>
        `"${p.playerName}" (already in ${p.existingGroup})`
      ).join(', ');

      console.log("❌ Duplicate players detected:", duplicateList);
      return res.status(400).json({
        success: false,
        message: `Cannot add players: The following players are already in the top players list for this sport: ${duplicateList}`,
        duplicatePlayers: duplicatePlayers,
      });
    }

    // Generate group name if not provided
    const finalGroupName = groupName || `Seeded Players - ${groupId}`;

    // Find if a record already exists for this group
    let topPlayersDoc = await TopPlayers.findOne({ tournamentId, groupId });

    if (!topPlayersDoc) {
      // If document doesn't exist and we have players, create it
      if (formattedTopPlayers.length > 0) {
        topPlayersDoc = new TopPlayers({
          tournamentId,
          sportId: _sportId,
          groupId,
          groupName: finalGroupName,
          topPlayers: formattedTopPlayers,
          players: formattedTopPlayers
        });
        await topPlayersDoc.save({ validateModifiedOnly: true });
        console.log(`Created new top player group "${finalGroupName}" with ${formattedTopPlayers.length} players`);
      }
    } else {
      // If document exists
      if (formattedTopPlayers.length > 0) {
        // Filter out players already in this group to avoid duplicates within the same group
        const existingPlayerIds = new Set();

        // Check both arrays for existing IDs
        if (topPlayersDoc.players) {
          topPlayersDoc.players.forEach(p => {
            if (p.playerId) existingPlayerIds.add(p.playerId.toString());
          });
        }
        if (topPlayersDoc.topPlayers) {
          topPlayersDoc.topPlayers.forEach(p => {
            if (p.playerId) existingPlayerIds.add(p.playerId.toString());
          });
        }

        const newPlayersToAppend = formattedTopPlayers.filter(
          p => !existingPlayerIds.has(p.playerId.toString())
        );

        if (newPlayersToAppend.length > 0) {
          // Push new players to both arrays
          topPlayersDoc.topPlayers.push(...newPlayersToAppend);
          topPlayersDoc.players.push(...newPlayersToAppend);
          topPlayersDoc.groupName = finalGroupName; // Update name
          await topPlayersDoc.save({ validateModifiedOnly: true });
          console.log(`Appended ${newPlayersToAppend.length} players to existing group "${finalGroupName}"`);
        } else {
          console.log(`No new players to append for group "${finalGroupName}" (all already exist)`);
        }
      } else {
        // If empty list sent, delete the whole group record
        await TopPlayers.deleteOne({ _id: topPlayersDoc._id });
        console.log(`Deleted empty top player group: ${groupId}`);
        topPlayersDoc = null;
      }
    }

    res.json({
      success: true,
      message: topPlayersDoc ? "Top players updated successfully" : "Top players cleared successfully",
      data: topPlayersDoc,
    });

  } catch (error) {
    console.error("=== ERROR SAVING TOP PLAYERS ===");
    console.error("Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save top players",
      error: error.message,
    });
  }
};

exports.getTopPlayersByGroup = async (req, res) => {
  try {
    const { tournamentId, groupId } = req.params;

    const topPlayers = await TopPlayers.findOne({ tournamentId, groupId });

    if (!topPlayers) {
      return res.json({
        success: false,
        message: "No top players found for this group",
      });
    }

    res.json({
      success: true,
      data: topPlayers,
    });
  } catch (error) {
    console.error("Error fetching top players:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch top players",
    });
  }
};

// Helper: fetch TopPlayers for a tournament, join with GroupStandings to
// attach `position` (group-stage rank) and `isSeeded` to each entry, and
// return both a flat list and a position-bucketed view.
//   flat       — augmented top-player entries (all the existing fields plus
//                isSeeded + position).
//   byPosition — { 1: [...], 2: [...], ..., seeded: [...], unranked: [...] }.
//                Numeric keys are dynamic (driven by observed ranks).
// Reused by getTopPlayersByTournament (mobile/manager UIs) and initiateRound2
// (server-authoritative partition for the position-based Round 2 options).
async function computeTopPlayersData(tournamentId, sportId = null) {
  // Multi-sport: when sportId is provided, scope results to that sport.
  // Strict match (no null fallback) — STEP 9d migration backfills sportId
  // on every TopPlayers doc, so post-migration data is fully scoped.
  const filter = sportId ? { tournamentId, sportId } : { tournamentId };
  const docs = await TopPlayers.find(filter);
  if (!docs || docs.length === 0) {
    return { flat: [], byPosition: { seeded: [], unranked: [] } };
  }

  // Seeded TopPlayers docs use a synthetic groupId like "seeded_open" — skip
  // those when querying GroupStandings (no real BookingGroup behind them).
  const GroupStandings = require("../src/modules/tournaments/models/GroupStandings");
  const isSeededGroupId = (gid) => typeof gid === "string" && gid.startsWith("seeded_");
  const realGroupIds = [
    ...new Set(
      docs
        .map((g) => String(g.groupId || ""))
        .filter((gid) => gid && !isSeededGroupId(gid))
    ),
  ];

  const rankByKey = new Map();
  if (realGroupIds.length > 0) {
    const standings = await GroupStandings.find({
      tournamentId,
      groupId: { $in: realGroupIds },
    });
    for (const doc of standings) {
      const gid = String(doc.groupId);
      for (const entry of doc.standings || []) {
        if (!entry.playerId || !entry.rank) continue;
        rankByKey.set(`${gid}|${String(entry.playerId)}`, entry.rank);
      }
    }
  }

  const flat = docs.flatMap((group) => {
    // Prefer the new 'players' array structure, fallback to legacy 'topPlayers'
    const playersList = (group.players && group.players.length > 0) ? group.players : group.topPlayers;
    const gid = String(group.groupId || "");
    const seeded = isSeededGroupId(gid);

    return (playersList || []).map((player) => {
      const pid = String(player.playerId || player._id || "");
      const position = seeded ? null : (rankByKey.get(`${gid}|${pid}`) || null);
      return {
        _id: player._id,
        playerId: player.playerId || player._id,
        playerName: player.playerName || player.userName,
        userName: player.userName || player.playerName,
        points: player.points,
        setsWon: player.setsWon,
        setsLost: player.setsLost,
        won: player.won,
        lost: player.lost,
        played: player.played,
        category: player.category || 'Open',
        groupId: group.groupId,
        groupName: group.groupName,
        status: player.status || 'top_player',
        sourceRound: player.sourceRound || 1,
        isSeeded: seeded,
        position,
        skipRound2: !!player.skipRound2,
      };
    });
  });

  const byPosition = { seeded: [], unranked: [] };
  for (const p of flat) {
    if (p.isSeeded) {
      byPosition.seeded.push(p);
    } else if (p.position == null) {
      byPosition.unranked.push(p);
    } else {
      if (!byPosition[p.position]) byPosition[p.position] = [];
      byPosition[p.position].push(p);
    }
  }

  return { flat, byPosition };
}

exports.getTopPlayersByTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { sportId } = req.query;

    const { flat, byPosition } = await computeTopPlayersData(tournamentId, sportId || null);

    if (flat.length === 0) {
      return res.json({
        success: false,
        message: "No top players found for this tournament",
        topPlayers: [],
        byPosition: { seeded: [], unranked: [] },
      });
    }

    // 📱 STANDARD RESPONSE
    res.json({
      success: true,
      topPlayers: flat,
      byPosition,
    });
  } catch (error) {
    console.error("Error fetching top players by tournament:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch top players for the tournament",
      topPlayers: [],
      byPosition: { seeded: [], unranked: [] },
    });
  }
};


// Remove a single player from a TopPlayers group (used when manager un-stars a
// previously seeded player). If removing the last player empties both arrays,
// the TopPlayers document is deleted entirely so the group disappears.
exports.removeTopPlayer = async (req, res) => {
  try {
    const { tournamentId, groupId, playerId } = req.params;
    if (!tournamentId || !groupId || !playerId) {
      return res.status(400).json({
        success: false,
        message: "tournamentId, groupId, and playerId are required",
      });
    }

    const doc = await TopPlayers.findOne({ tournamentId, groupId });
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Top players group not found",
      });
    }

    const matches = (arr) =>
      (arr || []).filter((p) => (p.playerId?.toString?.() || p.playerId) === playerId.toString());

    const playersHits = matches(doc.players).length;
    const topPlayersHits = matches(doc.topPlayers).length;
    if (playersHits + topPlayersHits === 0) {
      return res.status(404).json({
        success: false,
        message: "Player not found in this top players group",
      });
    }

    doc.players = (doc.players || []).filter(
      (p) => (p.playerId?.toString?.() || p.playerId) !== playerId.toString()
    );
    doc.topPlayers = (doc.topPlayers || []).filter(
      (p) => (p.playerId?.toString?.() || p.playerId) !== playerId.toString()
    );

    const groupEmptied = doc.players.length === 0 && doc.topPlayers.length === 0;
    if (groupEmptied) {
      await TopPlayers.deleteOne({ _id: doc._id });
    } else {
      await doc.save();
    }

    return res.json({
      success: true,
      message: groupEmptied
        ? "Player removed and empty group deleted"
        : "Player removed from top players group",
      removed: 1,
      groupEmptied,
    });
  } catch (error) {
    console.error("Error removing top player:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to remove player from top players group",
      error: error.message,
    });
  }
};


// Toggle the `skipRound2` flag on a Top Player. When true, the player is
// seeded for the final knockout (Round 3) and skips Round 2 entirely.
// Body: { playerId: string, skip: boolean }
// Searches across all the tournament's TopPlayers docs because a player can
// appear in any one of them (real group, "seeded_*" R1-skip group, etc.).
exports.toggleSkipRound2 = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { playerId, skip } = req.body;

    if (!tournamentId || !playerId || typeof skip !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: "tournamentId, playerId, and skip (boolean) are required",
      });
    }

    const docs = await TopPlayers.find({ tournamentId });
    if (!docs || docs.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No top players found for this tournament",
      });
    }

    const pidStr = playerId.toString();
    let updatedCount = 0;
    let updatedDoc = null;

    for (const doc of docs) {
      let docTouched = false;
      for (const arrName of ['players', 'topPlayers']) {
        const arr = doc[arrName] || [];
        for (const p of arr) {
          const ppid = (p.playerId?.toString?.() || p.playerId || '').toString();
          if (ppid === pidStr) {
            p.skipRound2 = skip;
            docTouched = true;
            updatedCount++;
          }
        }
      }
      if (docTouched) {
        await doc.save();
        updatedDoc = doc;
      }
    }

    if (updatedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Player not found in any TopPlayers entry for this tournament",
      });
    }

    return res.json({
      success: true,
      message: skip
        ? "Player seeded for the final knockout (will skip Round 2)"
        : "Player un-seeded — they will play Round 2",
      updatedCount,
      skipRound2: skip,
    });
  } catch (error) {
    console.error("Error toggling skipRound2:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to toggle skip-Round-2 flag",
      error: error.message,
    });
  }
};


exports.getLogo = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      console.error("Tournament not found with ID:", req.params.id);
      return res.status(404).json({ error: "Tournament not found" });
    }

    if (!tournament.tournamentLogo) {
      console.error(
        "Tournament logo not found for tournament:",
        tournament.title
      );
      return res.status(404).json({ error: "Tournament logo not found" });
    }

    // Construct the full path to the tournament logo file using the uploadsDir
    const logoPath = path.join(
      __dirname,
      "..",
      "uploads",
      tournament.tournamentLogo
    );
    console.log("Full tournament logo path:", logoPath);

    // Check if the file exists
    if (!fs.existsSync(logoPath)) {
      console.error("Tournament logo file not found at path:", logoPath);
      return res.status(404).json({ error: "Tournament logo file not found" });
    }

    // Set the appropriate content type based on the file extension
    const fileExtension = path.extname(logoPath).toLowerCase().slice(1);
    const contentTypes = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    const contentType =
      contentTypes[fileExtension] || "application/octet-stream";
    console.log("Tournament logo file content type:", contentType);

    // Set response headers
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600"); // Cache for 1 hour

    // Stream the file instead of loading it entirely into memory
    const fileStream = fs.createReadStream(logoPath);
    fileStream.pipe(res);

    // Handle stream errors
    fileStream.on("error", (err) => {
      console.error("Error streaming tournament logo:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error serving tournament logo" });
      }
    });

    // Log success after the stream ends
    fileStream.on("end", () => {
      console.log("Tournament logo served successfully");
    });
  } catch (error) {
    console.error("Error fetching tournament logo:", error);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Error fetching tournament logo" });
    }
  }
};

//*Tournament Progression System*//

// Add seeded players to tournament
exports.addSeededPlayers = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { seededPlayers } = req.body;

    if (!Array.isArray(seededPlayers) || seededPlayers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "seededPlayers array is required"
      });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // Validate and update seeded players
    for (const seedData of seededPlayers) {
      const { playerId, seedRank } = seedData;

      // Check if player exists
      const player = await User.findById(playerId);
      if (!player) {
        return res.status(404).json({
          success: false,
          message: `Player with ID ${playerId} not found`
        });
      }

      // Update player type to seeded
      await User.findByIdAndUpdate(playerId, {
        playerType: "seeded",
        seedRank: seedRank,
        nationalRanking: seedData.nationalRanking || null
      });
    }

    // Update tournament with seeded players
    tournament.seededPlayers = seededPlayers;
    await tournament.save();

    res.status(200).json({
      success: true,
      message: "Seeded players added successfully",
      tournament
    });

  } catch (error) {
    console.error("Error adding seeded players:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add seeded players",
      error: error.message
    });
  }
};

// Generate Qualifier Knockout matches (Round 2)
exports.generateQualifierKnockout = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { category } = req.query;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // Get top players from group stage for this category
    const topPlayersData = await TopPlayers.find({
      tournamentId: tournamentId
    }).populate('topPlayers');

    if (!topPlayersData || topPlayersData.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No group stage results found. Complete group stage first."
      });
    }

    // Extract all top players and mark them as Super Players
    const superPlayers = [];
    for (const groupData of topPlayersData) {
      for (const playerData of groupData.topPlayers) {
        // Update player type to super
        await User.findOneAndUpdate(
          { name: playerData.userName },
          { playerType: "super" }
        );

        const user = await User.findOne({ name: playerData.userName });
        if (user) {
          superPlayers.push({
            playerId: user._id,
            playerName: user.name,
            playerType: "super",
            fromGroup: groupData.groupName,
            points: playerData.points
          });
        }
      }
    }

    console.log("Super players:", superPlayers);

    // Generate qualifier knockout bracket
    const { resolveSportId: _resolveSportId_qk } = require("../utils/sportTrackUtils");
    const _qkSportId = _resolveSportId_qk(tournament, req.body?.sportId || req.query?.sportId);
    const qualifierMatches = await generateKnockoutBracket(
      superPlayers,
      tournamentId,
      "qualifier_knockout",
      2,
      "Qualifier",
      category || "Open",
      _qkSportId
    );

    // Update tournament stage
    await Tournament.findByIdAndUpdate(tournamentId, {
      currentStage: "qualifier_knockout",
      "stageConfig.groupStage.completed": true
    });

    res.status(201).json({
      success: true,
      message: "Qualifier knockout matches generated successfully",
      matches: qualifierMatches,
      superPlayersCount: superPlayers.length
    });

  } catch (error) {
    console.error("Error generating qualifier knockout:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate qualifier knockout",
      error: error.message
    });
  }
};

// Generate Main Knockout Stage (Round 3) - Merge Super + Seeded Players
exports.generateMainKnockout = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { category } = req.query;

    const tournament = await Tournament.findById(tournamentId).populate('seededPlayers.playerId');
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // Get qualifier knockout winners (Super Players who won Round 2)
    const qualifierMatches = await KnockoutMatch.find({
      tournamentId,
      matchType: "qualifier_knockout",
      status: "COMPLETED"
    });

    const qualifierWinners = qualifierMatches
      .filter(match => match.winner && match.winner.playerId)
      .map(match => ({
        playerId: match.winner.playerId,
        playerName: match.winner.playerName,
        playerType: "super",
        fromQualifier: true
      }));

    console.log("Qualifier winners:", qualifierWinners);

    // Get seeded players for this category
    const seededPlayers = tournament.seededPlayers
      .filter(seed => !category || seed.category === category)
      .map(seed => ({
        playerId: seed.playerId._id,
        playerName: seed.playerId.name,
        playerType: "seeded",
        seedRank: seed.seedRank,
        autoAdvanced: true
      }));

    console.log("Seeded players:", seededPlayers);

    // Merge Super Players + Seeded Players
    const mainKnockoutPlayers = [...qualifierWinners, ...seededPlayers];

    console.log("Main knockout players:", mainKnockoutPlayers.length);

    // Generate main knockout bracket
    const { resolveSportId: _resolveSportId_mk } = require("../utils/sportTrackUtils");
    const _mkSportId = _resolveSportId_mk(tournament, req.body?.sportId || req.query?.sportId);
    const mainKnockoutMatches = await generateKnockoutBracket(
      mainKnockoutPlayers,
      tournamentId,
      "main_knockout",
      3,
      "Main Knockout",
      category || "Open",
      _mkSportId
    );

    // Update tournament stage
    await Tournament.findByIdAndUpdate(tournamentId, {
      currentStage: "main_knockout",
      "stageConfig.qualifierKnockout.completed": true
    });

    res.status(201).json({
      success: true,
      message: "Main knockout matches generated successfully",
      matches: mainKnockoutMatches,
      totalPlayers: mainKnockoutPlayers.length,
      superPlayers: qualifierWinners.length,
      seededPlayers: seededPlayers.length
    });

  } catch (error) {
    console.error("Error generating main knockout:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate main knockout",
      error: error.message
    });
  }
};

// Bracket Generation Algorithm with Bye System
// sportId is optional — when null, MatchFactory's _stamp falls back to
// tournament.sports[0].sportId (or null for legacy single-sport).
const generateKnockoutBracket = async (players, tournamentId, matchType, round, roundName, category, sportId = null) => {
  try {
    const totalPlayers = players.length;

    // Calculate next power of 2 to determine bracket size
    const nextPowerOf2 = Math.pow(2, Math.ceil(Math.log2(totalPlayers)));
    const byesNeeded = nextPowerOf2 - totalPlayers;

    console.log(`Total players: ${totalPlayers}, Next power of 2: ${nextPowerOf2}, Byes needed: ${byesNeeded}`);

    // Shuffle players for fair bracket distribution
    const shuffledPlayers = shuffle(players);

    // For seeded players, place them strategically to avoid early encounters
    if (matchType === "main_knockout") {
      shuffledPlayers.sort((a, b) => {
        if (a.playerType === "seeded" && b.playerType === "seeded") {
          return a.seedRank - b.seedRank; // Lower seed rank comes first
        }
        if (a.playerType === "seeded") return -1;
        if (b.playerType === "seeded") return 1;
        return 0;
      });
    }

    const matches = [];
    let bracketPosition = 1;

    // Create matches, handling byes
    for (let i = 0; i < shuffledPlayers.length; i += 2) {
      const player1 = shuffledPlayers[i];
      const player2 = shuffledPlayers[i + 1] || null;

      // Determine if this is a bye match
      const isBye = !player2;
      let status = "SCHEDULED";
      let winner = null;

      if (isBye) {
        status = "BYE";
        winner = {
          playerId: player1.playerId,
          playerName: player1.playerName,
          playerType: player1.playerType
        };
      }

      // Use MatchFactory for consistent multi-sport match creation
      const tournament = await Tournament.findById(tournamentId);
      const matchDoc = createLegacyKnockoutMatch({
        tournament,
        tournamentId,
        sportId, // multi-sport: explicit, factory falls back to sports[0].sportId
        matchType,
        round,
        roundName,
        bracketPosition,
        player1: {
          playerId: player1.playerId,
          playerName: player1.playerName,
          playerType: player1.playerType,
          seedRank: player1.seedRank || null,
          fromGroup: player1.fromGroup || null,
        },
        player2: player2 ? {
          playerId: player2.playerId,
          playerName: player2.playerName,
          playerType: player2.playerType,
          seedRank: player2.seedRank || null,
          fromGroup: player2.fromGroup || null,
        } : undefined,
        category,
        status,
        isBye,
        winner,
      });
      const match = new KnockoutMatch(matchDoc);
      await match.save({ validateModifiedOnly: true });
      matches.push(match);
      bracketPosition++;
    }

    console.log(`Generated ${matches.length} matches for ${roundName}`);
    return matches;

  } catch (error) {
    console.error("Error in generateKnockoutBracket:", error);
    throw error;
  }
};

// Get tournament progression status
exports.getTournamentProgression = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await Tournament.findById(tournamentId).populate('seededPlayers.playerId');
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // Get group stage status
    const groupStageGroups = await BookingGroup.find({ tournamentId });
    const groupStageMatches = await Match.find({ tournamentId });
    const topPlayers = await TopPlayers.find({ tournamentId });

    // Get knockout matches
    const qualifierMatches = await KnockoutMatch.find({
      tournamentId,
      matchType: "qualifier_knockout"
    });

    const mainKnockoutMatches = await KnockoutMatch.find({
      tournamentId,
      matchType: "main_knockout"
    });

    // STEP 17b.iv — read currentStage / stageConfig per-sport (sports[0]).
    const { getCurrentStage: _gcs, getStageConfig: _gsc } = require("../utils/sportTrackUtils");
    const _stageForResp = _gcs(tournament);
    const _stageConfigForResp = _gsc(tournament);
    const progression = {
      currentStage: _stageForResp,
      stageConfig: _stageConfigForResp,
      groupStage: {
        totalGroups: groupStageGroups.length,
        totalMatches: groupStageMatches.length,
        completedMatches: groupStageMatches.filter(m => m.status === "COMPLETED").length,
        topPlayersSelected: topPlayers.length > 0
      },
      qualifierKnockout: {
        totalMatches: qualifierMatches.length,
        completedMatches: qualifierMatches.filter(m => m.status === "COMPLETED").length,
        superPlayersQualified: qualifierMatches.filter(m => m.winner).length
      },
      mainKnockout: {
        totalMatches: mainKnockoutMatches.length,
        completedMatches: mainKnockoutMatches.filter(m => m.status === "COMPLETED").length,
        seededPlayersCount: tournament.seededPlayers.length
      }
    };

    res.status(200).json({
      success: true,
      progression,
      tournament: {
        id: tournament._id,
        title: tournament.title,
        currentStage: _stageForResp,
        tournamentStatus: tournament.tournamentStatus
      }
    });

  } catch (error) {
    console.error("Error getting tournament progression:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get tournament progression",
      error: error.message
    });
  }
};

//* MATCH FORMAT CONFIGURATION CONTROLLERS *//

// 🚀 Get Available Match Format Options (for UI dropdowns)
exports.getMatchFormatOptions = async (req, res) => {
  try {
    const options = {
      success: true,
      setsOptions: [
        { value: 3, label: "3 Sets (First to 2 wins)", description: "Quick matches" },
        { value: 5, label: "5 Sets (First to 3 wins)", description: "Standard tournament" },
        { value: 7, label: "7 Sets (First to 4 wins)", description: "Epic matches" }
      ],
      gamesOptions: [
        { value: 3, label: "3 Games (First to 2 wins set)", description: "Fast sets" },
        { value: 5, label: "5 Games (First to 3 wins set)", description: "Standard sets" },
        { value: 7, label: "7 Games (First to 4 wins set)", description: "Long sets" }
      ],
      combinations: [
        { sets: 3, games: 3, name: "Quick Match", duration: "~15 min" },
        { sets: 3, games: 5, name: "Standard Short", duration: "~25 min" },
        { sets: 3, games: 7, name: "Long Games", duration: "~35 min" },
        { sets: 5, games: 3, name: "Fast Tournament", duration: "~25 min" },
        { sets: 5, games: 5, name: "Tournament Standard", duration: "~45 min" },
        { sets: 5, games: 7, name: "Extended Match", duration: "~60 min" },
        { sets: 7, games: 3, name: "Sprint Epic", duration: "~35 min" },
        { sets: 7, games: 5, name: "Professional", duration: "~75 min" },
        { sets: 7, games: 7, name: "Marathon", duration: "~90 min" }
      ]
    };

    res.status(200).json(options);
  } catch (error) {
    console.error("Error fetching match format options:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch match format options",
      error: error.message
    });
  }
};

// STEP 17b.iv — DEPRECATED. Per-tournament-level matchFormat endpoints
// were never wired to a frontend caller (only the per-group variants
// at /bookinggroups/:groupId/match-format are used). The tournament-
// level endpoints would write to the deprecated root tournament.matchFormat
// (silently stripped after 17e schema removal). Both return 410 Gone.
// Use the regular tournament edit endpoint with sports[i].matchFormat
// instead.

exports.getTournamentMatchFormat = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: "ENDPOINT_DEPRECATED",
    message: "GET /tournaments/:id/match-format is deprecated as of STEP 17b.iv. Read tournament.sports[i].matchFormat from the tournament-by-id endpoint instead.",
  });
};

exports.updateTournamentMatchFormat = async (req, res) => {
  return res.status(410).json({
    success: false,
    error: "ENDPOINT_DEPRECATED",
    message: "PUT /tournaments/:id/match-format is deprecated as of STEP 17b.iv. Update sports[i].matchFormat via the regular tournament edit endpoint with a sports[] payload instead.",
  });
};

// Get Specific Match Format Configuration
exports.getMatchFormat = async (req, res) => {
  try {
    const { matchId } = req.params;

    const match = await Match.findById(matchId)
      .select('matchFormat')
      .populate('tournamentId', 'matchFormat title');

    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Match not found"
      });
    }

    // Match format inherits from tournament but can be overridden
    const inheritedFormat = match.tournamentId?.matchFormat || {};
    const matchFormat = { ...inheritedFormat, ...match.matchFormat };

    res.status(200).json({
      success: true,
      matchId: match._id,
      tournamentTitle: match.tournamentId?.title,
      matchFormat,
      isInherited: Object.keys(match.matchFormat || {}).length === 0
    });
  } catch (error) {
    console.error("Error fetching match format:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch match format",
      error: error.message
    });
  }
};

// Update Specific Match Format Configuration
exports.updateMatchFormat = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { matchFormat } = req.body;

    // Validate match format
    const validationErrors = validateMatchFormat(matchFormat);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid match format configuration",
        errors: validationErrors
      });
    }

    const match = await Match.findByIdAndUpdate(
      matchId,
      { matchFormat },
      { new: true, runValidators: true }
    ).populate('tournamentId', 'matchFormat title');

    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Match not found"
      });
    }

    // Return merged configuration
    const inheritedFormat = match.tournamentId?.matchFormat || {};
    const finalFormat = { ...inheritedFormat, ...match.matchFormat };

    res.status(200).json({
      success: true,
      message: "Match format updated successfully",
      matchId: match._id,
      matchFormat: finalFormat
    });
  } catch (error) {
    console.error("Error updating match format:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update match format",
      error: error.message
    });
  }
};

// Helper function to validate match format
// 🚀 ENHANCED FLEXIBLE VALIDATION - Supports independent Sets & Games configuration
function validateMatchFormat(matchFormat) {
  const errors = [];

  if (!matchFormat) {
    errors.push("Match format is required");
    return errors;
  }

  // 🎯 FLEXIBLE SETS VALIDATION & AUTO-CALCULATION
  if (matchFormat.totalSets) {
    if (![3, 5, 7].includes(matchFormat.totalSets)) {
      errors.push("totalSets must be 3, 5, or 7");
    } else {
      // 🔥 AUTO-CALCULATE setsToWin based on totalSets
      matchFormat.setsToWin = Math.ceil(matchFormat.totalSets / 2);
      matchFormat.maxSets = matchFormat.totalSets; // Backward compatibility

      console.log(`🎯 Sets Auto-calculated: ${matchFormat.totalSets} total → First to ${matchFormat.setsToWin} wins match`);
    }
  }

  // 🎯 FLEXIBLE GAMES VALIDATION & AUTO-CALCULATION
  if (matchFormat.totalGames) {
    if (![3, 5, 7].includes(matchFormat.totalGames)) {
      errors.push("totalGames must be 3, 5, or 7");
    } else {
      // 🔥 AUTO-CALCULATE gamesToWin based on totalGames
      matchFormat.gamesToWin = Math.ceil(matchFormat.totalGames / 2);
      matchFormat.maxGames = matchFormat.totalGames; // Backward compatibility

      console.log(`🎯 Games Auto-calculated: ${matchFormat.totalGames} total → First to ${matchFormat.gamesToWin} wins set`);
    }
  }

  // 🔄 BACKWARD COMPATIBILITY - Support old format
  if (!matchFormat.totalSets && matchFormat.maxSets) {
    if ([3, 5, 7].includes(matchFormat.maxSets)) {
      matchFormat.totalSets = matchFormat.maxSets;
      matchFormat.setsToWin = Math.ceil(matchFormat.maxSets / 2);
      console.log(`🔄 Legacy: maxSets ${matchFormat.maxSets} → totalSets ${matchFormat.totalSets}, setsToWin ${matchFormat.setsToWin}`);
    }
  }

  if (!matchFormat.totalGames && matchFormat.maxGames) {
    if ([3, 5, 7].includes(matchFormat.maxGames)) {
      matchFormat.totalGames = matchFormat.maxGames;
      matchFormat.gamesToWin = Math.ceil(matchFormat.maxGames / 2);
      console.log(`🔄 Legacy: maxGames ${matchFormat.maxGames} → totalGames ${matchFormat.totalGames}, gamesToWin ${matchFormat.gamesToWin}`);
    }
  }

  // 🔍 VALIDATION FOR AUTO-CALCULATED VALUES
  if (matchFormat.setsToWin && ![2, 3, 4].includes(matchFormat.setsToWin)) {
    errors.push("setsToWin must be 2 (for 3 sets), 3 (for 5 sets), or 4 (for 7 sets)");
  }

  if (matchFormat.gamesToWin && ![2, 3, 4].includes(matchFormat.gamesToWin)) {
    errors.push("gamesToWin must be 2 (for 3 games), 3 (for 5 games), or 4 (for 7 games)");
  }

  // Validate points configuration
  if (matchFormat.pointsToWinGame && matchFormat.pointsToWinGame < 1) {
    errors.push("pointsToWinGame must be at least 1");
  }

  if (matchFormat.marginToWin && matchFormat.marginToWin < 1) {
    errors.push("marginToWin must be at least 1");
  }

  // Validate service rules
  if (matchFormat.serviceRule) {
    if (matchFormat.serviceRule.pointsPerService && matchFormat.serviceRule.pointsPerService < 1) {
      errors.push("pointsPerService must be at least 1");
    }
    if (matchFormat.serviceRule.deuceServicePoints && matchFormat.serviceRule.deuceServicePoints < 1) {
      errors.push("deuceServicePoints must be at least 1");
    }
  }

  return errors;
}

// Add the missing getMatchesByGroup method
exports.getMatchesByGroup = async (req, res) => {
  try {
    const { tournamentId, groupId } = req.params;

    if (!tournamentId || !groupId) {
      return res.status(400).json({
        success: false,
        message: "Tournament ID and Group ID are required"
      });
    }

    const matches = await Match.find({ tournamentId, groupId })
      .populate('player1.playerId', 'name userName profileImage')
      .populate('player2.playerId', 'name userName profileImage')
      .populate('tournamentId', 'title type matchFormat')
      .sort({ matchNumber: 1 });

    if (!matches || matches.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No matches found for this group",
        matches: []
      });
    }

    // Enrich matches with proper structure for frontend - with null safety
    const enrichedMatches = matches.map(match => {
      const matchObj = match.toObject();

      return {
        ...matchObj,
        player1: {
          playerId: match.player1?.playerId?._id || match.player1?.playerId,
          userName: match.player1?.playerId?.userName ||
            match.player1?.playerId?.name ||
            match.player1?.userName ||
            'Unknown Player',
          name: match.player1?.playerId?.name || match.player1?.userName || 'Unknown Player',
          profileImage: match.player1?.playerId?.profileImage
        },
        player2: {
          playerId: match.player2?.playerId?._id || match.player2?.playerId,
          userName: match.player2?.playerId?.userName ||
            match.player2?.playerId?.name ||
            match.player2?.userName ||
            'Unknown Player',
          name: match.player2?.playerId?.name || match.player2?.userName || 'Unknown Player',
          profileImage: match.player2?.playerId?.profileImage
        }
      };
    });

    res.status(200).json({
      success: true,
      matches: enrichedMatches
    });

  } catch (error) {
    console.error("Error fetching matches by group:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch matches",
      error: error.message
    });
  }
};

// ===================== CLEANUP FUNCTIONS =====================

// Clean up Super Players incorrectly added to Top Players list
exports.cleanupSuperPlayersFromTopPlayers = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    console.log("=== CLEANUP: Removing Super Players from Top Players ===");
    console.log("Tournament ID:", tournamentId);

    // Get all Top Players documents for this tournament using the same method as getTopPlayersByTournament
    const topPlayers = await TopPlayers.find({ tournamentId });
    console.log("Found top players groups:", topPlayers.length);

    if (!topPlayers || topPlayers.length === 0) {
      return res.json({
        success: true,
        message: "No Top Players found to clean up",
        removedCount: 0
      });
    }

    // Flatten the top players data like in getTopPlayersByTournament
    let allTopPlayers = [];
    topPlayers.forEach(group => {
      if (group.topPlayers && Array.isArray(group.topPlayers)) {
        group.topPlayers.forEach(player => {
          allTopPlayers.push({
            ...player.toObject ? player.toObject() : player,
            groupId: group.groupId,
            groupName: group.groupName || group.groupId,
            groupDoc: group // Keep reference to original document
          });
        });
      }
    });

    console.log("Total flattened players:", allTopPlayers.length);

    // Identify Super Players based on characteristics
    let superPlayersToRemove = [];
    let legitimateTopPlayers = [];

    allTopPlayers.forEach(player => {
      const isSuperPlayer = (
        // 1. Status field indicates super_player
        player.status === 'super_player' ||
        // 2. Source round is 2 (indicates Round 2 winner)
        player.sourceRound === 2 ||
        // 3. Group ID contains "super_players"
        (player.groupId && player.groupId.toString().includes('super_players')) ||
        // 4. Group name contains "Super Players"
        (player.groupName && player.groupName.includes('Super Players'))
      );

      if (isSuperPlayer) {
        console.log(`Found Super Player to remove:`, {
          name: player.userName || player.playerName,
          status: player.status,
          sourceRound: player.sourceRound,
          groupId: player.groupId,
          groupName: player.groupName
        });
        superPlayersToRemove.push(player);
      } else {
        legitimateTopPlayers.push(player);
      }
    });

    console.log(`Super Players to remove: ${superPlayersToRemove.length}`);
    console.log(`Legitimate Top Players to keep: ${legitimateTopPlayers.length}`);

    if (superPlayersToRemove.length === 0) {
      return res.json({
        success: true,
        message: "No Super Players found to clean up",
        removedCount: 0
      });
    }

    // Group the cleanup by document/group for efficient updates
    let cleanupResults = [];

    // Process removals by group
    for (const group of topPlayers) {
      const originalCount = group.topPlayers ? group.topPlayers.length : 0;

      if (!group.topPlayers || !Array.isArray(group.topPlayers)) {
        continue;
      }

      // Filter out Super Players from this group - MORE AGGRESSIVE CLEANUP
      const filteredPlayers = group.topPlayers.filter(player => {
        const playerObj = player.toObject ? player.toObject() : player;
        const isSuperPlayer = (
          // 1. Status field indicates super_player
          playerObj.status === 'super_player' ||
          // 2. Source round is 2 (indicates Round 2 winner)
          playerObj.sourceRound === 2 ||
          // 3. Group ID contains "super_players" or "round_2"
          (group.groupId && (
            group.groupId.toString().includes('super_players') ||
            group.groupId.toString().includes('round_2')
          )) ||
          // 4. Group name contains "Super Players" or "Round 2"
          (group.groupName && (
            group.groupName.includes('Super Players') ||
            group.groupName.includes('Round 2')
          )) ||
          // 5. Player name appears multiple times (duplicates from Super Player selection)
          (playerObj.userName && ['Aditya', 'Sneha', 'Jayesh', 'Chaitali'].some(name =>
            playerObj.userName.includes(name) && (
              playerObj.status === 'super_player' ||
              playerObj.sourceRound === 2 ||
              group.groupId.toString().includes('super_players') ||
              group.groupId.toString().includes('round_2')
            )
          ))
        );
        return !isSuperPlayer;
      });

      const removedCount = originalCount - filteredPlayers.length;

      if (removedCount > 0) {
        console.log(`Removing ${removedCount} Super Players from group ${group.groupId}`);

        // Update the group document
        group.topPlayers = filteredPlayers;
        await group.save();

        cleanupResults.push({
          groupId: group.groupId,
          groupName: group.groupName,
          originalCount,
          removedCount,
          newCount: filteredPlayers.length
        });
      }
    }

    const totalRemovedCount = cleanupResults.reduce((sum, result) => sum + result.removedCount, 0);

    console.log("=== CLEANUP COMPLETED ===");
    console.log("Total Super Players removed from Top Players:", totalRemovedCount);

    res.json({
      success: true,
      message: `Successfully cleaned up ${totalRemovedCount} Super Players from Top Players list`,
      removedCount: totalRemovedCount,
      cleanupResults,
      details: `Processed ${topPlayers.length} Top Player groups`
    });

  } catch (error) {
    console.error("Error during Super Players cleanup:", error);
    res.status(500).json({
      success: false,
      message: "Failed to cleanup Super Players from Top Players",
      error: error.message
    });
  }
};

// AGGRESSIVE cleanup - Remove ALL Super Players regardless of group
exports.aggressiveCleanupSuperPlayers = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    console.log("=== AGGRESSIVE CLEANUP: Removing ALL Super Players ===");
    console.log("Tournament ID:", tournamentId);

    // Get ALL TopPlayers documents for this tournament
    const topPlayersDocuments = await TopPlayers.find({ tournamentId });
    console.log("Found documents:", topPlayersDocuments.length);

    let totalRemovedCount = 0;
    let processedGroups = [];

    for (const doc of topPlayersDocuments) {
      if (!doc.topPlayers || !Array.isArray(doc.topPlayers)) {
        continue;
      }

      const originalCount = doc.topPlayers.length;
      console.log(`Processing group ${doc.groupId} with ${originalCount} players`);

      // Remove ALL players with super_player status or sourceRound 2
      const filteredPlayers = doc.topPlayers.filter(player => {
        const playerObj = player.toObject ? player.toObject() : player;
        const isSuperPlayer = (
          playerObj.status === 'super_player' ||
          playerObj.sourceRound === 2
        );

        if (isSuperPlayer) {
          console.log(`Removing Super Player: ${playerObj.userName || playerObj.playerName} from group ${doc.groupId}`);
        }

        return !isSuperPlayer; // Keep only legitimate Top Players
      });

      const removedCount = originalCount - filteredPlayers.length;

      if (removedCount > 0) {
        doc.topPlayers = filteredPlayers;
        await doc.save();
        totalRemovedCount += removedCount;

        processedGroups.push({
          groupId: doc.groupId,
          groupName: doc.groupName,
          originalCount,
          removedCount,
          newCount: filteredPlayers.length
        });
      }
    }

    console.log("=== AGGRESSIVE CLEANUP COMPLETED ===");
    console.log("Total removed:", totalRemovedCount);

    res.json({
      success: true,
      message: `Aggressively removed ${totalRemovedCount} Super Players from Top Players`,
      removedCount: totalRemovedCount,
      processedGroups
    });

  } catch (error) {
    console.error("Error during aggressive cleanup:", error);
    res.status(500).json({
      success: false,
      message: "Failed to perform aggressive cleanup",
      error: error.message
    });
  }
};

// Save Super Players (Round 2 Winners)
exports.saveSuperPlayers = async (req, res) => {
  try {
    const { tournamentId, groupId, groupName, round, roundType, players } = req.body;

    if (!tournamentId || !players || players.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Tournament ID and players are required"
      });
    }

    // Multi-sport: scope the upsert to the per-sport SuperPlayers doc.
    // Without this, calling /superplayers/save for sport B on a multi-sport
    // tournament would APPEND sport B's players into sport A's existing
    // doc (mixing rosters across sports). Sport context is required —
    // resolve via the same path the rest of the controller uses.
    const { resolveSportId: _resolveSportId_save } = require("../utils/sportTrackUtils");
    const _tournamentForSPSave = await Tournament.findById(tournamentId).lean();
    const _saveSPSportId = _resolveSportId_save(_tournamentForSPSave, req.body.sportId);

    // Check if Super Players document already exists for THIS SPORT.
    let superPlayersDoc = await SuperPlayers.findOne({
      tournamentId,
      sportId: _saveSPSportId,
    });

    if (superPlayersDoc) {
      // Append to existing Super Players document.
      // Get existing player IDs to avoid duplicates
      const existingPlayerIds = new Set(
        superPlayersDoc.players.map(p => p.playerId?.toString() || p.playerId)
      );

      // Filter out duplicate players and ensure proper ObjectId conversion
      const newPlayers = players
        .filter(player =>
          !existingPlayerIds.has(player.playerId?.toString() || player.playerId)
        )
        .map(player => ({
          ...player,
          playerId: mongoose.Types.ObjectId.isValid(player.playerId)
            ? new mongoose.Types.ObjectId(player.playerId)
            : player.playerId
        }));

      if (newPlayers.length > 0) {
        superPlayersDoc.players.push(...newPlayers);
        // STEP 17f — UPDATE on existing SuperPlayers; validateModifiedOnly
        // skips required:true on unmodified sportId path.
        await superPlayersDoc.save({ validateModifiedOnly: true });

        return res.json({
          success: true,
          message: `Added ${newPlayers.length} new Super Players`,
          superPlayersDoc,
          addedPlayers: newPlayers.length,
          totalSuperPlayers: superPlayersDoc.players.length
        });
      } else {
        return res.json({
          success: true,
          message: "All players were already in Super Players collection",
          superPlayersDoc,
          addedPlayers: 0,
          totalSuperPlayers: superPlayersDoc.players.length
        });
      }
    } else {
      // Create new Super Players document.
      // Ensure playerId is properly converted to ObjectId
      const processedPlayers = players.map(player => ({
        ...player,
        playerId: mongoose.Types.ObjectId.isValid(player.playerId)
          ? new mongoose.Types.ObjectId(player.playerId)
          : player.playerId
      }));

      // sportId already resolved at the top of the handler (_saveSPSportId).
      const newSuperPlayersDoc = new SuperPlayers({
        tournamentId,
        sportId: _saveSPSportId,
        players: processedPlayers
      });

      await newSuperPlayersDoc.save();

      return res.json({
        success: true,
        message: `Created Super Players collection with ${players.length} players`,
        superPlayersDoc: newSuperPlayersDoc,
        addedPlayers: players.length,
        totalSuperPlayers: players.length
      });
    }

  } catch (error) {
    console.error("Error saving Super Players:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save Super Players",
      error: error.message
    });
  }
};

// ===================== SUPER PLAYERS KNOCKOUT SYSTEM =====================

// Generate Knockout Matches for Super Players
exports.generateKnockoutMatches = async (req, res) => {
  const { tournamentId } = req.body || {};

  // Lock per-tournament to prevent concurrent generate requests racing.
  if (tournamentId && knockoutGenerationLocks.has(String(tournamentId))) {
    return res.status(409).json({
      success: false,
      message: "Another bracket generation is already in progress for this tournament. Please wait for it to finish."
    });
  }
  if (tournamentId) knockoutGenerationLocks.add(String(tournamentId));

  try {
    const {
      courtNumber,
      matchStartTime,
      // Per-round knockout config (Step 3 of flexible bestOf):
      //   rounds: [{ roundNumber, bestOf, slotDurationMinutes, matchDurationMinutes }]
      //   breakBetweenRoundsMinutes: optional wall-clock break between rounds
      // Backward compat: when rounds[] is missing, the legacy single-value
      // slotDurationMinutes/matchDurationMinutes are fanned to every round
      // by assignKnockoutSlots; bestOf cascades from defaults.
      rounds,
      breakBetweenRoundsMinutes,
      slotDurationMinutes,
      matchDurationMinutes,
      // New optional params — when omitted, we keep legacy sequential pairing.
      drawSize: requestedDrawSize,
      numberOfSeeds: requestedNumberOfSeeds = 0,
      // Optional explicit ordering of players (by playerId). When provided,
      // the SuperPlayers array is reordered to match — so the preview shown
      // in the UI and the generated bracket are byte-for-byte identical.
      playerOrder,
    } = req.body;

    // Tournament + match format. Loaded BEFORE the SuperPlayers fetch so
    // sportId can be validated and used to scope the SuperPlayers query
    // (multi-sport tournaments must not bleed players across sports).
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ success: false, message: "Tournament not found" });
    }

    // STEP 16d — sportId required at the boundary for knockout generate.
    // Tournament-level (no group context); manager UI sends activeSportId.
    try {
      assertSportInTournament(req.body.sportId, tournament);
    } catch (err) {
      if (handleSportContextError(err, res)) return;
      throw err;
    }
    const _knockoutSportId = req.body.sportId;

    // Get Super Players for this tournament + sport (ordered by group-stage rank).
    // Sport-scoped — without this, multi-sport tournaments mix rosters.
    const superPlayersDoc = await SuperPlayers.findOne({
      tournamentId,
      sportId: _knockoutSportId,
    }).populate('players.playerId', 'name');
    if (!superPlayersDoc || !superPlayersDoc.players.length) {
      return res.status(404).json({
        success: false,
        message: "No Super Players found for this tournament/sport"
      });
    }

    // Apply explicit player ordering when the client sent one.
    //
    // playerOrder is AUTHORITATIVE — it's what the manager confirmed in the
    // preview modal. The server filters SuperPlayers down to exactly those
    // IDs in the requested order. SuperPlayers not in playerOrder are
    // intentionally excluded so the resulting bracket matches the preview
    // (e.g. 19 players → 13 BYEs in a 32-draw, not the full SuperPlayers
    // count silently filling slots).
    let players = superPlayersDoc.players;
    if (Array.isArray(playerOrder) && playerOrder.length > 0) {
      const orderIdx = new Map();
      playerOrder.forEach((pid, i) => {
        if (pid) orderIdx.set(String(pid), i);
      });
      const idOf = (p) => {
        const raw = p.playerId?._id || p.playerId || p._id;
        return raw ? String(raw) : "";
      };
      // Filter to only players in playerOrder, then sort by their position
      // in playerOrder. Unmatched IDs in playerOrder are silently dropped
      // (logged so the cause is investigable if it ever happens).
      players = superPlayersDoc.players
        .filter((p) => orderIdx.has(idOf(p)))
        .sort((a, b) => orderIdx.get(idOf(a)) - orderIdx.get(idOf(b)));

      const matched = new Set(players.map(idOf));
      const unmatchedIds = playerOrder.filter((pid) => pid && !matched.has(String(pid)));
      if (unmatchedIds.length > 0) {
        console.warn(
          `[KO] playerOrder contained ${unmatchedIds.length} ID(s) not in SuperPlayers; ignored: ${unmatchedIds.join(", ")}`
        );
      }
    }
    const playerCount = players.length;

    // STEP 17b.iv — matchFormat read per-sport (after sportId validated).
    const { getMatchFormat: _gmfKO } = require("../utils/sportTrackUtils");
    if (!_gmfKO(tournament, _knockoutSportId)) {
      return res.status(400).json({
        success: false,
        message: "Tournament matchFormat is not configured. Please set match format before generating knockout matches."
      });
    }

    // Validate draw size + number of seeds if provided.
    const useExplicitDrawSize = requestedDrawSize != null;
    if (useExplicitDrawSize) {
      if (!VALID_KO_DRAW_SIZES.includes(requestedDrawSize)) {
        return res.status(400).json({
          success: false,
          message: `Invalid drawSize ${requestedDrawSize}. Valid: ${VALID_KO_DRAW_SIZES.join(", ")}`
        });
      }
      if (playerCount > requestedDrawSize) {
        return res.status(400).json({
          success: false,
          message: `Too many players (${playerCount}) for a ${requestedDrawSize}-draw. Reduce draw size mismatch.`
        });
      }
      if (requestedNumberOfSeeds < 0 || requestedNumberOfSeeds > requestedDrawSize) {
        return res.status(400).json({
          success: false,
          message: `numberOfSeeds ${requestedNumberOfSeeds} out of range for drawSize ${requestedDrawSize}.`
        });
      }
    }

    // Delete existing knockout matches for this tournament + sport.
    // Sport-scoped — without this, generating a knockout for sport B on a
    // multi-sport tournament would wipe sport A's already-generated bracket.
    await SuperMatch.deleteMany({ tournamentId, sportId: _knockoutSportId });

    // Decide bracket: use explicit drawSize when provided, else infer from player count.
    // The legacy generateBracketStructure helper returns { rounds: [{name, abbreviation, roundNumber, matchCount}] }
    // which we need to preserve for time scheduling + match naming.
    const bracket = useExplicitDrawSize
      ? buildBracketFromDrawSize(requestedDrawSize)
      : generateBracketStructure(playerCount);
    const bracketSize = useExplicitDrawSize
      ? requestedDrawSize
      : Math.max(...bracket.rounds.map(r => r.matchCount)) * 2;

    // Build R1 slot assignment.
    // - Priority BYE placement via shared buildR1SlotAssignment helper when
    //   numberOfSeeds > 0 (seeded at Mirror & Flip slots, BYEs on top-seed
    //   opponent lines, extras random, rest shuffled into unseeded slots).
    // - Otherwise: sequential pairing (legacy behavior preserved).
    let r1Slots;
    const applyMirrorFlip = useExplicitDrawSize && requestedNumberOfSeeds > 0;

    if (applyMirrorFlip) {
      // Helper returns full slot assignment with priority BYE logic built in.
      // `players` is already in rank order (seeded first, then Round 1
      // qualifiers, per the playerOrder the client sent).
      const { slots } = buildR1SlotAssignment({
        drawSize: bracketSize,
        numberOfSeeds: requestedNumberOfSeeds,
        players: players.map((p) => ({
          playerId: p.playerId,
          playerName: p.playerName,
        })),
      });
      r1Slots = slots;
    } else {
      // Legacy sequential pairing: players 0..playerCount-1 occupy slots in order.
      r1Slots = new Array(bracketSize).fill(null);
      for (let i = 0; i < bracketSize; i++) {
        if (i < playerCount) {
          r1Slots[i] = {
            playerId: players[i].playerId,
            playerName: players[i].playerName,
            seed: i + 1,
          };
        }
      }
    }

    // ── Court + time scheduling (Sub-step 4) ──────────────────────────────
    // Pull the active court pool for this sport. Filter rules:
    //   - isActive !== false (skip retired courts)
    //   - sportId is null (tournament-wide) OR matches the active sport
    // Empty pool → legacy single-court fallback (`courtNumber || "1"`),
    // which produces continuous linear scheduling (the pre-Sub-step-4 path).
    const courtPool = (tournament.courts || [])
      .filter((c) => c.isActive !== false)
      .filter((c) => !c.sportId || String(c.sportId) === String(_knockoutSportId))
      .map((c) => c.name);

    const { assignKnockoutSlots, bestOfToSetFormat } = require("../utils/courtScheduling");
    // Set-based sports get per-round bestOf overrides applied to each match's
    // matchFormat. Other scoring types (time/innings/single) ignore bestOf —
    // bestOfToSetFormat returns null for them and the factory falls back to
    // the resolved tournament format unchanged.
    const _activeSportFormat = require("../utils/sportTrackUtils").getMatchFormat(tournament, _knockoutSportId) || {};
    const _isSetBased = (_activeSportFormat.scoringType || "").toLowerCase() === "sets";
    const slots = assignKnockoutSlots({
      bracket,
      courtPool,
      legacyCourtNumber: courtNumber,
      baseTime: new Date(matchStartTime),
      rounds,
      slotDurationMinutes,
      matchDurationMinutes,
      breakBetweenRoundsMinutes,
    });

    const matches = [];
    let slotIdx = 0;

    for (const round of bracket.rounds) {
      for (let i = 0; i < round.matchCount; i++) {
        const slot = slots[slotIdx++];
        const matchId = `${tournamentId}_${round.abbreviation}_${i + 1}`;

        let player1, player2;
        if (round.roundNumber === 1) {
          // Pull from our slot assignment. R1 null slot → BYE.
          player1 = r1Slots[i * 2]     || { playerId: null, playerName: "BYE", seed: null };
          player2 = r1Slots[i * 2 + 1] || { playerId: null, playerName: "BYE", seed: null };
        } else {
          player1 = { playerId: null, playerName: "TBD", seed: null };
          player2 = { playerId: null, playerName: "TBD", seed: null };
        }

        let nextMatchId = null;
        if (round.roundNumber < bracket.rounds.length) {
          const nextRound = bracket.rounds[round.roundNumber];
          const nextMatchNumber = Math.floor(i / 2) + 1;
          nextMatchId = `${tournamentId}_${nextRound.abbreviation}_${nextMatchNumber}`;
        }

        const _override = _isSetBased ? bestOfToSetFormat(slot.bestOf) : null;
        const matchDoc = createSuperMatch({
          tournament,
          tournamentId,
          sportId: _knockoutSportId,
          matchId,
          round: round.name,
          roundNumber: round.roundNumber,
          matchNumber: i + 1,
          player1,
          player2,
          courtNumber: slot.courtNumber,
          matchStartTime: slot.matchStartTime,
          matchEndTime: slot.matchEndTime,
          matchFormatOverride: _override,
          nextMatchId,
        });

        matches.push(matchDoc);
      }
    }

    // Persist
    await SuperMatch.insertMany(matches);

    // Auto-BYE: advance real players from R1 BYE matches to their R2 slot.
    let byeCount = 0;
    const safeSave = async (doc) => {
      try { await doc.save(); }
      catch (err) {
        if (err && err.name === "DocumentNotFoundError") {
          console.warn(`[KO BYE] Skipped save for missing doc _id=${doc._id} (likely concurrent delete).`);
          return;
        }
        throw err;
      }
    };
    const isRealPlayer = (p) => {
      const name = p?.playerName;
      return !!name && name !== "TBD" && name !== "BYE";
    };
    // Sport-scoped — auto-BYE pass must only see this sport's R1 matches,
    // otherwise a multi-sport tournament's BYE pass would scan and possibly
    // mutate the other sport's bracket.
    const r1Matches = await SuperMatch.find({ tournamentId, sportId: _knockoutSportId, roundNumber: 1 });
    for (const match of r1Matches) {
      const p1Real = isRealPlayer(match.player1);
      const p2Real = isRealPlayer(match.player2);
      if (p1Real === p2Real) continue; // either both real (playable) or both missing (no-op)

      const realPlayer = p1Real ? match.player1 : match.player2;
      match.status = "COMPLETED";
      match.winner = {
        playerId: realPlayer.playerId,
        playerName: realPlayer.playerName,
      };
      match.notes = `BYE — ${realPlayer.playerName} advances automatically (no opponent).`;

      if (match.nextMatchId) {
        const nextMatch = await SuperMatch.findOne({ matchId: match.nextMatchId });
        if (nextMatch) {
          const slot = match.matchNumber % 2 !== 0 ? "player1" : "player2";
          nextMatch[slot] = {
            playerId: realPlayer.playerId,
            playerName: realPlayer.playerName,
            seed: realPlayer.seed ?? null,
          };
          await safeSave(nextMatch);
        }
      }
      await safeSave(match);
      byeCount++;
    }

    res.json({
      success: true,
      message: `Generated ${matches.length} knockout matches${byeCount ? ` (${byeCount} auto-BYEs)` : ""}`,
      matchesCreated: matches.length,
      bracket: bracket,
      bracketSize,
      byeCount,
      matches: matches.map(m => ({
        matchId: m.matchId,
        round: m.round,
        player1: m.player1.playerName,
        player2: m.player2.playerName,
        matchStartTime: m.matchStartTime
      }))
    });

  } catch (error) {
    console.error("Error generating knockout matches:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate knockout matches",
      error: error.message
    });
  } finally {
    if (tournamentId) knockoutGenerationLocks.delete(String(tournamentId));
  }
};

// Helper: build a bracket-rounds structure from an explicit power-of-2 draw size.
// Mirrors the shape returned by generateBracketStructure(playerCount) below
// so the scheduling + match-naming loop can treat both paths identically.
function buildBracketFromDrawSize(drawSize) {
  const rounds = [];
  let roundNumber = 1;
  let matchCount = drawSize / 2;
  // drawSize 2 → final only; else we have multiple rounds.
  while (matchCount >= 1) {
    let name, abbreviation;
    if (matchCount === 1)       { name = "final";          abbreviation = "F";   }
    else if (matchCount === 2)  { name = "semi-final";     abbreviation = "SF";  }
    else if (matchCount === 4)  { name = "quarter-final";  abbreviation = "QF";  }
    else                        { name = `round-of-${matchCount * 2}`; abbreviation = `R${matchCount * 2}`; }
    rounds.push({ name, abbreviation, roundNumber: roundNumber++, matchCount });
    if (matchCount === 1) break;
    matchCount = matchCount / 2;
  }
  return { rounds };
}

// Helper function to generate bracket structure based on player count
function generateBracketStructure(playerCount) {
  let rounds = [];
  let currentPlayers = playerCount;
  let roundNumber = 1;

  // Determine the starting round based on player count
  if (playerCount <= 2) {
    rounds.push({
      name: "final",
      abbreviation: "F",
      roundNumber: roundNumber++,
      matchCount: 1
    });
  } else if (playerCount <= 4) {
    rounds.push({
      name: "semi-final",
      abbreviation: "SF",
      roundNumber: roundNumber++,
      matchCount: 2
    });
    rounds.push({
      name: "final",
      abbreviation: "F",
      roundNumber: roundNumber++,
      matchCount: 1
    });
  } else if (playerCount <= 8) {
    rounds.push({
      name: "quarter-final",
      abbreviation: "QF",
      roundNumber: roundNumber++,
      matchCount: 4
    });
    rounds.push({
      name: "semi-final",
      abbreviation: "SF",
      roundNumber: roundNumber++,
      matchCount: 2
    });
    rounds.push({
      name: "final",
      abbreviation: "F",
      roundNumber: roundNumber++,
      matchCount: 1
    });
  } else {
    // For more than 8 players, start with pre-quarters
    let matchesInFirstRound = Math.ceil(currentPlayers / 2);

    rounds.push({
      name: "pre-quarter",
      abbreviation: "PQ",
      roundNumber: roundNumber++,
      matchCount: matchesInFirstRound
    });

    currentPlayers = matchesInFirstRound;

    // Add subsequent rounds
    while (currentPlayers > 1) {
      let matchCount = Math.ceil(currentPlayers / 2);

      if (currentPlayers <= 8 && currentPlayers > 4) {
        rounds.push({
          name: "quarter-final",
          abbreviation: "QF",
          roundNumber: roundNumber++,
          matchCount: matchCount
        });
      } else if (currentPlayers <= 4 && currentPlayers > 2) {
        rounds.push({
          name: "semi-final",
          abbreviation: "SF",
          roundNumber: roundNumber++,
          matchCount: matchCount
        });
      } else if (currentPlayers === 2) {
        rounds.push({
          name: "final",
          abbreviation: "F",
          roundNumber: roundNumber++,
          matchCount: 1
        });
      }

      currentPlayers = matchCount;
    }
  }

  return {
    totalPlayers: playerCount,
    totalRounds: rounds.length,
    rounds: rounds
  };
}

// Delete all knockout matches for a tournament
exports.deleteAllKnockoutMatches = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    // Knockout matches can live in any of three collections depending on the
    // tournament's flow (group->KO via SuperMatch, standalone DirectKnockout,
    // or legacy qualifier_knockout KnockoutMatch). Clear all three so the
    // Knockout tab is actually empty afterward.
    const SuperMatch = require("../src/modules/tournaments/models/SuperMatch");
    const DirectKnockoutMatch = require("../src/modules/tournaments/models/DirectKnockoutMatch");
    const KnockoutMatch = require("../src/modules/tournaments/models/KnockoutMatch");

    const [sm, dk, km] = await Promise.all([
      SuperMatch.deleteMany({ tournamentId }),
      DirectKnockoutMatch.deleteMany({ tournamentId }),
      KnockoutMatch.deleteMany({ tournamentId }),
    ]);
    const deletedCount = (sm.deletedCount || 0) + (dk.deletedCount || 0) + (km.deletedCount || 0);

    res.json({
      success: true,
      message: `Deleted ${deletedCount} knockout matches`,
      deletedCount,
      breakdown: {
        superMatch: sm.deletedCount || 0,
        directKnockout: dk.deletedCount || 0,
        legacyKnockout: km.deletedCount || 0,
      },
    });
  } catch (error) {
    console.error("Error deleting knockout matches:", error);
    res.status(500).json({ success: false, message: "Failed to delete knockout matches" });
  }
};

// Get Knockout Matches for a tournament
// POST /api/tournaments/:tournamentId/knockout/redistribute-courts
//   Body: { sportId?, rounds?, breakBetweenRoundsMinutes?, slotDurationMinutes?, matchDurationMinutes? }
//
// Recomputes courtNumber + matchStartTime + matchEndTime against the existing
// SuperMatch bracket. matchFormat (totalSets / setsToWin) is NOT rewritten —
// per-round bestOf changes apply to fresh generations only. If the manager
// wants to retroactively change a round's bestOf, they must regenerate.
//
// Re-runs round-robin court assignment + round-aware scheduling against the
// existing SuperMatch knockout bracket WITHOUT regenerating it. Player
// assignments, seeding, scores, and winners are preserved — only courtNumber
// and matchStartTime are rewritten.
//
// Use case: catalog had only one court when bracket was generated, manager
// added more courts later and wants matches spread across them. Avoids the
// "Delete All + Generate" round-trip that would clobber any in-progress
// scoring or completed-match results.
//
// Skips matches whose status is "completed" or "in-progress" — we don't
// rewrite history or interrupt live scoring.
exports.redistributeKnockoutCourts = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const {
      sportId = null,
      rounds,
      breakBetweenRoundsMinutes,
      slotDurationMinutes,
      matchDurationMinutes,
    } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(tournamentId)) {
      return res.status(400).json({ success: false, message: "Invalid tournamentId" });
    }

    const tournament = await Tournament.findById(tournamentId).select("courts sports").lean();
    if (!tournament) {
      return res.status(404).json({ success: false, message: "Tournament not found" });
    }

    const _sportId = sportId || tournament.sports?.[0]?.sportId || null;

    const courtPool = (tournament.courts || [])
      .filter((c) => c.isActive !== false)
      .filter((c) => !c.sportId || String(c.sportId) === String(_sportId))
      .map((c) => c.name);

    if (courtPool.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No active courts in catalog. Add courts first."
      });
    }

    const matchFilter = _sportId
      ? { tournamentId, sportId: _sportId }
      : { tournamentId };
    const matches = await SuperMatch.find(matchFilter)
      .sort({ roundNumber: 1, matchNumber: 1 })
      .lean();

    if (matches.length === 0) {
      return res.status(404).json({ success: false, message: "No knockout matches found" });
    }

    // Group matches by roundNumber; the scheduler needs a bracket shape.
    const byRound = {};
    matches.forEach((m) => {
      const r = m.roundNumber || 1;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(m);
    });
    const roundNumbers = Object.keys(byRound).map(Number).sort((a, b) => a - b);
    const bracket = {
      rounds: roundNumbers.map((rn) => ({
        roundNumber: rn,
        matchCount: byRound[rn].length,
      })),
    };

    // Derive baseTime from the earliest existing matchStartTime so the new
    // schedule starts at the same wall-clock as before.
    const earliest = matches.reduce((acc, m) => {
      const t = m.matchStartTime ? new Date(m.matchStartTime) : null;
      if (!t) return acc;
      return acc == null || t < acc ? t : acc;
    }, null) || new Date();

    const { assignKnockoutSlots } = require("../utils/courtScheduling");
    const slots = assignKnockoutSlots({
      bracket,
      courtPool,
      legacyCourtNumber: courtPool[0],
      baseTime: earliest,
      rounds,
      slotDurationMinutes,
      matchDurationMinutes,
      breakBetweenRoundsMinutes,
    });

    // Walk slots in the same nested-loop order used to build the bracket
    // shape and pair each slot with its corresponding existing match.
    const ops = [];
    let skipped = 0;
    let updated = 0;
    let slotIdx = 0;
    for (const rn of roundNumbers) {
      for (const m of byRound[rn]) {
        const slot = slots[slotIdx++];
        if (!slot) continue;
        const status = String(m.status || "").toLowerCase();
        if (status === "completed" || status === "in-progress" || status === "in_progress") {
          skipped++;
          continue;
        }
        ops.push({
          updateOne: {
            filter: { _id: m._id },
            update: {
              $set: {
                courtNumber: slot.courtNumber,
                matchStartTime: slot.matchStartTime,
                matchEndTime: slot.matchEndTime,
              },
            },
          },
        });
        updated++;
      }
    }

    if (ops.length > 0) {
      await SuperMatch.bulkWrite(ops, { ordered: false });
    }

    return res.status(200).json({
      success: true,
      updated,
      skipped,
      courtPool,
      message: `Redistributed ${updated} match${updated === 1 ? "" : "es"} across ${courtPool.length} courts${
        skipped > 0 ? ` (${skipped} live or completed match${skipped === 1 ? "" : "es"} skipped)` : ""
      }.`,
    });
  } catch (err) {
    console.error("Error redistributing knockout courts:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to redistribute courts",
      error: err.message,
    });
  }
};

exports.getKnockoutMatches = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { sportId } = req.query;

    // Multi-sport: strict sportId match on SuperMatch.
    const matchFilter = sportId ? { tournamentId, sportId } : { tournamentId };

    // BookingGroup query includes sportId-null docs (pre-migration safety).
    const groupFilter = sportId
      ? { tournamentId, $or: [{ sportId }, { sportId: null }] }
      : { tournamentId };

    // Run both queries in parallel; .lean() skips Mongoose document
    // hydration (~5-10x faster on populated lists). The per-match
    // .toObject() mapping below is no longer needed since lean docs
    // are already plain objects.
    const [matches, groups] = await Promise.all([
      SuperMatch.find(matchFilter)
        .populate('player1.playerId', 'name profileImage')
        .populate('player2.playerId', 'name profileImage')
        .populate('winner.playerId', 'name profileImage')
        .sort({ roundNumber: 1, matchNumber: 1 })
        .lean(),
      BookingGroup.find(groupFilter).select("groupName category players").lean(),
    ]);

    // Enrich each match with a category derived from the originating BookingGroup.
    // SuperMatch doesn't carry category itself; resolve via player → group → category.
    const playerIdToCategory = {};
    const playerNameToCategory = {};
    groups.forEach((g) => {
      if (!g.category) return;
      (g.players || []).forEach((p) => {
        if (p.playerId) playerIdToCategory[p.playerId.toString()] = g.category;
        if (p.userName) playerNameToCategory[p.userName] = g.category;
      });
    });

    const enriched = matches.map((m) => {
      const p1Id = m.player1?.playerId?._id?.toString?.() || m.player1?.playerId?.toString?.();
      const p2Id = m.player2?.playerId?._id?.toString?.() || m.player2?.playerId?.toString?.();
      const cat =
        playerIdToCategory[p1Id] ||
        playerIdToCategory[p2Id] ||
        playerNameToCategory[m.player1?.playerName] ||
        playerNameToCategory[m.player2?.playerName] ||
        null;
      if (cat) m.category = cat;
      return m;
    });

    // Group matches by round
    const matchesByRound = {};
    enriched.forEach((match) => {
      if (!matchesByRound[match.round]) {
        matchesByRound[match.round] = [];
      }
      matchesByRound[match.round].push(match);
    });

    res.json({
      success: true,
      totalMatches: enriched.length,
      matches: enriched,
      matchesByRound: matchesByRound,
    });

  } catch (error) {
    console.error("Error fetching knockout matches:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch knockout matches",
      error: error.message
    });
  }
};


// Update Match Result
exports.updateKnockoutMatchResult = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { winnerId, winnerName, loserData, score, status } = req.body;

    // Validate required parameters
    if (!matchId) {
      return res.status(400).json({
        success: false,
        message: "Match ID is required"
      });
    }

    const match = await SuperMatch.findOne({ matchId });
    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Match not found"
      });
    }

    // Validate that the match is not already completed
    if (match.status === "COMPLETED" && match.winner?.playerId) {
      return res.status(400).json({
        success: false,
        message: "Match is already completed",
        currentWinner: match.winner.playerName
      });
    }

    // Validate winner is one of the match participants
    if (winnerId && winnerName) {
      const isValidWinner =
        (match.player1.playerId && match.player1.playerId.toString() === winnerId.toString()) ||
        (match.player2.playerId && match.player2.playerId.toString() === winnerId.toString());

      if (!isValidWinner) {
        return res.status(400).json({
          success: false,
          message: "Winner must be one of the match participants",
          participants: [match.player1.playerName, match.player2.playerName]
        });
      }
    }

    // Update match result
    match.winner = {
      playerId: winnerId,
      playerName: winnerName
    };
    match.loser = loserData;
    match.score = score;

    // Ensure status is properly set to "COMPLETED" when winner is determined
    if (winnerId && winnerName) {
      match.status = "COMPLETED";
    } else {
      match.status = status || "IN_PROGRESS";
    }

    // Calculate comprehensive statistics if match is completed
    if (match.status === "COMPLETED" && score && score.setScores) {
      const statistics = calculateMatchStatistics(match, score);
      match.statistics = statistics;
    }

    await match.save({ validateModifiedOnly: true });

    console.log(`SuperMatch ${matchId} updated: Status=${match.status}, Winner=${winnerName}`);

    // Progress winner to next round if applicable
    if (match.status === "COMPLETED") {
      try {
        await progressWinnerToNextRound(match);
      } catch (progressError) {
        console.error("Error progressing winner:", progressError);
        // Don't fail the match update if progression fails
      }
    }

    res.json({
      success: true,
      message: "Match result updated successfully",
      match: match
    });

  } catch (error) {
    console.error("Error updating match result:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update match result",
      error: error.message
    });
  }
};

// Helper function to progress winner to next round
async function progressWinnerToNextRound(completedMatch, session = null) {
  // Check if this match has a next match to progress to
  if (!completedMatch.nextMatchId) {
    console.log(`Match ${completedMatch.matchId} is the final match - no progression needed`);
    return;
  }

  // Find the next match using the nextMatchId
  const query = {
    matchId: completedMatch.nextMatchId,
    tournamentId: completedMatch.tournamentId
  };

  // Try to find the next match in both SuperMatch and DirectKnockoutMatch collections
  let nextMatch = session ?
    await SuperMatch.findOne(query).session(session) :
    await SuperMatch.findOne(query);

  // If not found in SuperMatch, try DirectKnockoutMatch
  if (!nextMatch) {
    nextMatch = session ?
      await DirectKnockoutMatch.findOne(query).session(session) :
      await DirectKnockoutMatch.findOne(query);
  }

  if (!nextMatch) {
    console.error(`Next match ${completedMatch.nextMatchId} not found for match ${completedMatch.matchId} in any collection (SuperMatch or DirectKnockoutMatch)`);
    return;
  }

  // Determine if winner goes to player1 or player2 position based on match number
  const isPlayer1Position = (completedMatch.matchNumber - 1) % 2 === 0;

  // 🔥 DYNAMIC SCHEMA DETECTION FOR WINNER PROGRESSION!
  let winnerData;
  const isSuperMatch = completedMatch.constructor?.modelName === 'SuperMatch';
  const isDirectKnockout = completedMatch.constructor?.modelName === 'DirectKnockoutMatch';

  if (isSuperMatch) {
    // SuperMatch stores winner directly
    winnerData = completedMatch.winner;
  } else if (isDirectKnockout) {
    // DirectKnockoutMatch stores winner in result object (CRITICAL FIX!)
    winnerData = completedMatch.result?.winner;
  } else {
    // Fallback for other match types
    winnerData = completedMatch.winner || completedMatch.result?.winner;
  }

  if (!winnerData) {
    console.error(`No winner data found in completed match ${completedMatch.matchId}. Schema: ${completedMatch.constructor?.modelName}`);
    return;
  }

  const winnerInfo = {
    playerId: winnerData.playerId,
    playerName: winnerData.playerName,
    seed: winnerData.playerId === completedMatch.player1.playerId ?
      completedMatch.player1.seed : completedMatch.player2.seed
  };

  if (isPlayer1Position) {
    nextMatch.player1 = winnerInfo;
  } else {
    nextMatch.player2 = winnerInfo;
  }

  if (session) {
    await nextMatch.save({ session });
  } else {
    await nextMatch.save({ validateModifiedOnly: true });
  }

  console.log(`Winner ${winnerData.playerName} advanced from ${completedMatch.matchId} to ${nextMatch.matchId}`);
}

// Export the function so it can be used by other controllers
exports.progressWinnerToNextRound = progressWinnerToNextRound;
exports.calculateMatchStatistics = calculateMatchStatistics;

// Helper function to calculate comprehensive match statistics
function calculateMatchStatistics(match, score) {
  const statistics = {
    player1Stats: {
      setsWon: 0,
      setsLost: 0,
      gamesWon: 0,
      gamesLost: 0,
      totalPoints: 0,
      totalPointsAgainst: 0,
      matchesWon: 0,
      matchesLost: 0,
      matchesPlayed: 1
    },
    player2Stats: {
      setsWon: 0,
      setsLost: 0,
      gamesWon: 0,
      gamesLost: 0,
      totalPoints: 0,
      totalPointsAgainst: 0,
      matchesWon: 0,
      matchesLost: 0,
      matchesPlayed: 1
    }
  };

  // Calculate sets won/lost
  statistics.player1Stats.setsWon = score.player1Sets || 0;
  statistics.player1Stats.setsLost = score.player2Sets || 0;
  statistics.player2Stats.setsWon = score.player2Sets || 0;
  statistics.player2Stats.setsLost = score.player1Sets || 0;

  // Calculate games won/lost and points from individual sets
  if (score.setScores && Array.isArray(score.setScores)) {
    score.setScores.forEach(set => {
      const p1Score = set.player1Score || 0;
      const p2Score = set.player2Score || 0;

      // Add to total points
      statistics.player1Stats.totalPoints += p1Score;
      statistics.player1Stats.totalPointsAgainst += p2Score;
      statistics.player2Stats.totalPoints += p2Score;
      statistics.player2Stats.totalPointsAgainst += p1Score;

      // Count games won (each set is essentially a game in table tennis)
      if (p1Score > p2Score) {
        statistics.player1Stats.gamesWon += 1;
        statistics.player2Stats.gamesLost += 1;
      } else if (p2Score > p1Score) {
        statistics.player2Stats.gamesWon += 1;
        statistics.player1Stats.gamesLost += 1;
      }
    });
  }

  // Determine match winner/loser
  const isPlayer1Winner = match.winner && match.winner.playerId &&
    match.winner.playerId.toString() === match.player1.playerId.toString();

  if (isPlayer1Winner) {
    statistics.player1Stats.matchesWon = 1;
    statistics.player2Stats.matchesLost = 1;
  } else {
    statistics.player2Stats.matchesWon = 1;
    statistics.player1Stats.matchesLost = 1;
  }

  return statistics;
}

// Get tournament leaderboard/statistics
exports.getTournamentLeaderboard = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    // Get all completed SuperMatches for this tournament
    const matches = await SuperMatch.find({
      tournamentId,
      status: "COMPLETED"
    })
      .populate('player1.playerId', 'name profileImage')
      .populate('player2.playerId', 'name profileImage')
      .sort({ roundNumber: 1, matchNumber: 1 });

    if (!matches || matches.length === 0) {
      return res.json({
        success: true,
        leaderboard: [],
        message: "No completed matches found"
      });
    }

    // Aggregate statistics by player
    const playerStats = {};

    matches.forEach(match => {
      if (match.statistics) {
        // Process Player 1 stats
        const p1Id = match.player1.playerId._id.toString();
        if (!playerStats[p1Id]) {
          playerStats[p1Id] = {
            playerId: p1Id,
            playerName: match.player1.playerName,
            playerInfo: match.player1.playerId,
            setsWon: 0,
            setsLost: 0,
            gamesWon: 0,
            gamesLost: 0,
            totalPoints: 0,
            totalPointsAgainst: 0,
            matchesWon: 0,
            matchesLost: 0,
            matchesPlayed: 0
          };
        }

        // Add Player 1 statistics
        const p1Stats = match.statistics.player1Stats;
        playerStats[p1Id].setsWon += p1Stats.setsWon || 0;
        playerStats[p1Id].setsLost += p1Stats.setsLost || 0;
        playerStats[p1Id].gamesWon += p1Stats.gamesWon || 0;
        playerStats[p1Id].gamesLost += p1Stats.gamesLost || 0;
        playerStats[p1Id].totalPoints += p1Stats.totalPoints || 0;
        playerStats[p1Id].totalPointsAgainst += p1Stats.totalPointsAgainst || 0;
        playerStats[p1Id].matchesWon += p1Stats.matchesWon || 0;
        playerStats[p1Id].matchesLost += p1Stats.matchesLost || 0;
        playerStats[p1Id].matchesPlayed += p1Stats.matchesPlayed || 0;

        // Process Player 2 stats
        const p2Id = match.player2.playerId._id.toString();
        if (!playerStats[p2Id]) {
          playerStats[p2Id] = {
            playerId: p2Id,
            playerName: match.player2.playerName,
            playerInfo: match.player2.playerId,
            setsWon: 0,
            setsLost: 0,
            gamesWon: 0,
            gamesLost: 0,
            totalPoints: 0,
            totalPointsAgainst: 0,
            matchesWon: 0,
            matchesLost: 0,
            matchesPlayed: 0
          };
        }

        // Add Player 2 statistics
        const p2Stats = match.statistics.player2Stats;
        playerStats[p2Id].setsWon += p2Stats.setsWon || 0;
        playerStats[p2Id].setsLost += p2Stats.setsLost || 0;
        playerStats[p2Id].gamesWon += p2Stats.gamesWon || 0;
        playerStats[p2Id].gamesLost += p2Stats.gamesLost || 0;
        playerStats[p2Id].totalPoints += p2Stats.totalPoints || 0;
        playerStats[p2Id].totalPointsAgainst += p2Stats.totalPointsAgainst || 0;
        playerStats[p2Id].matchesWon += p2Stats.matchesWon || 0;
        playerStats[p2Id].matchesLost += p2Stats.matchesLost || 0;
        playerStats[p2Id].matchesPlayed += p2Stats.matchesPlayed || 0;
      }
    });

    // Convert to array and calculate additional metrics
    const leaderboard = Object.values(playerStats).map(player => {
      const winPercentage = player.matchesPlayed > 0 ?
        ((player.matchesWon / player.matchesPlayed) * 100).toFixed(2) : 0;

      const setWinPercentage = (player.setsWon + player.setsLost) > 0 ?
        ((player.setsWon / (player.setsWon + player.setsLost)) * 100).toFixed(2) : 0;

      const pointDifference = player.totalPoints - player.totalPointsAgainst;

      return {
        ...player,
        winPercentage: parseFloat(winPercentage),
        setWinPercentage: parseFloat(setWinPercentage),
        pointDifference: pointDifference,
        averagePointsPerMatch: player.matchesPlayed > 0 ?
          (player.totalPoints / player.matchesPlayed).toFixed(2) : 0
      };
    });

    // Sort by win percentage, then by point difference
    leaderboard.sort((a, b) => {
      if (b.winPercentage !== a.winPercentage) {
        return b.winPercentage - a.winPercentage;
      }
      return b.pointDifference - a.pointDifference;
    });

    // Add ranking
    leaderboard.forEach((player, index) => {
      player.rank = index + 1;
    });

    res.json({
      success: true,
      leaderboard: leaderboard,
      totalPlayers: leaderboard.length,
      totalMatches: matches.length
    });

  } catch (error) {
    console.error("Error fetching tournament leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tournament leaderboard",
      error: error.message
    });
  }
};

// Get comprehensive tournament statistics across all stages (Group, Round 2, Knockout)
exports.getComprehensiveTournamentStats = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    // Initialize player stats aggregator
    const playerStats = {};

    // Helper function to add player stats
    const addPlayerStats = (playerId, playerName, playerInfo, stats) => {
      if (!playerStats[playerId]) {
        playerStats[playerId] = {
          playerId,
          playerName,
          playerInfo,
          setsWon: 0,
          setsLost: 0,
          gamesWon: 0,
          gamesLost: 0,
          totalPoints: 0,
          totalPointsAgainst: 0,
          matchesWon: 0,
          matchesLost: 0,
          matchesPlayed: 0,
          stagesPlayed: []
        };
      }

      playerStats[playerId].setsWon += stats.setsWon || 0;
      playerStats[playerId].setsLost += stats.setsLost || 0;
      playerStats[playerId].gamesWon += stats.gamesWon || 0;
      playerStats[playerId].gamesLost += stats.gamesLost || 0;
      playerStats[playerId].totalPoints += stats.totalPoints || 0;
      playerStats[playerId].totalPointsAgainst += stats.totalPointsAgainst || 0;
      playerStats[playerId].matchesWon += stats.matchesWon || 0;
      playerStats[playerId].matchesLost += stats.matchesLost || 0;
      playerStats[playerId].matchesPlayed += stats.matchesPlayed || 0;
    };

    // Get Knockout stage matches (SuperMatch)
    const knockoutMatches = await SuperMatch.find({
      tournamentId,
      status: "COMPLETED"
    })
      .populate('player1.playerId', 'name profileImage')
      .populate('player2.playerId', 'name profileImage');

    knockoutMatches.forEach(match => {
      if (match.statistics) {
        if (match.player1?.playerId) {
          addPlayerStats(
            match.player1.playerId._id.toString(),
            match.player1.playerName,
            match.player1.playerId,
            match.statistics.player1Stats
          );
          if (!playerStats[match.player1.playerId._id.toString()].stagesPlayed.includes('Knockout')) {
            playerStats[match.player1.playerId._id.toString()].stagesPlayed.push('Knockout');
          }
        }

        if (match.player2?.playerId) {
          addPlayerStats(
            match.player2.playerId._id.toString(),
            match.player2.playerName,
            match.player2.playerId,
            match.statistics.player2Stats
          );
          if (!playerStats[match.player2.playerId._id.toString()].stagesPlayed.includes('Knockout')) {
            playerStats[match.player2.playerId._id.toString()].stagesPlayed.push('Knockout');
          }
        }
      }
    });

    // Calculate comprehensive metrics
    const leaderboard = Object.values(playerStats).map(player => {
      const winPercentage = player.matchesPlayed > 0 ?
        ((player.matchesWon / player.matchesPlayed) * 100).toFixed(2) : 0;

      const setWinPercentage = (player.setsWon + player.setsLost) > 0 ?
        ((player.setsWon / (player.setsWon + player.setsLost)) * 100).toFixed(2) : 0;

      const pointDifference = player.totalPoints - player.totalPointsAgainst;

      return {
        ...player,
        winPercentage: parseFloat(winPercentage),
        setWinPercentage: parseFloat(setWinPercentage),
        pointDifference: pointDifference,
        averagePointsPerMatch: player.matchesPlayed > 0 ?
          parseFloat((player.totalPoints / player.matchesPlayed).toFixed(2)) : 0,
        stagesPlayedCount: player.stagesPlayed.length
      };
    });

    // Sort by multiple criteria: win percentage, point difference
    leaderboard.sort((a, b) => {
      // First by win percentage
      if (b.winPercentage !== a.winPercentage) {
        return b.winPercentage - a.winPercentage;
      }
      // Then by point difference
      return b.pointDifference - a.pointDifference;
    });

    // Add ranking
    leaderboard.forEach((player, index) => {
      player.rank = index + 1;
    });

    res.json({
      success: true,
      leaderboard: leaderboard,
      totalPlayers: leaderboard.length,
      summary: {
        totalKnockoutMatches: knockoutMatches.length,
        playersInKnockout: knockoutMatches.length > 0 ?
          new Set([...knockoutMatches.map(m => m.player1.playerId._id.toString()),
          ...knockoutMatches.map(m => m.player2.playerId._id.toString())]).size : 0
      }
    });

  } catch (error) {
    console.error("Error fetching comprehensive tournament statistics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch comprehensive tournament statistics",
      error: error.message
    });
  }
};

// ===================== DIRECT KNOCKOUT SYSTEM =====================

// Validate players for direct knockout
exports.validateDirectKnockoutPlayers = async (req, res) => {
  try {
    const { tournamentId, selectedPlayers } = req.body;

    // Validate tournament exists
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // Validate player count
    if (!selectedPlayers || selectedPlayers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No players selected"
      });
    }

    // Check if count is power of 2
    const count = selectedPlayers.length;
    const isPowerOf2 = count > 0 && (count & (count - 1)) === 0;
    const validSizes = [4, 8, 16, 32];

    if (!isPowerOf2 || !validSizes.includes(count)) {
      return res.status(400).json({
        success: false,
        message: `Player count must be a power of 2. Valid sizes: ${validSizes.join(", ")}. Current count: ${count}`
      });
    }

    // Validate all players exist
    const playerIds = selectedPlayers.map(p => p.playerId).filter(Boolean);
    const existingPlayers = await User.find({ _id: { $in: playerIds } });

    if (existingPlayers.length !== playerIds.length) {
      return res.status(400).json({
        success: false,
        message: "Some selected players do not exist"
      });
    }

    res.json({
      success: true,
      message: "Players validated successfully",
      playerCount: count,
      rounds: Math.log2(count),
      totalMatches: count - 1
    });

  } catch (error) {
    console.error("Error validating direct knockout players:", error);
    res.status(500).json({
      success: false,
      message: "Failed to validate players",
      error: error.message
    });
  }
};

// Create direct knockout matches
exports.createDirectKnockoutMatches = async (req, res) => {
  try {
    const { tournamentId, selectedPlayers, schedule } = req.body;

    // Validate input
    if (!tournamentId || !selectedPlayers || !schedule) {
      return res.status(400).json({
        success: false,
        message: "Missing required data: tournamentId, selectedPlayers, or schedule"
      });
    }

    const { startDate, startTime, courtNumber, intervalMinutes } = schedule;

    // Validate tournament exists
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // Create bracket structure
    const playerCount = selectedPlayers.length;
    const rounds = Math.log2(playerCount);
    const totalMatches = playerCount - 1;

    // Shuffle players for random first round matchups
    const shuffledPlayers = shuffle(selectedPlayers);

    const matches = [];
    let matchCounter = 1;

    // Create first round matches
    for (let i = 0; i < shuffledPlayers.length; i += 2) {
      const player1 = shuffledPlayers[i];
      const player2 = shuffledPlayers[i + 1];

      // Calculate match start time
      const matchDateTime = new Date(`${startDate}T${startTime}`);
      matchDateTime.setMinutes(matchDateTime.getMinutes() + (matchCounter - 1) * intervalMinutes);

      const match = {
        tournamentId,
        matchId: `DK-${tournamentId}-${matchCounter}`,
        round: getRoundName(playerCount, 1),
        roundNumber: 1,
        matchNumber: matchCounter,
        player1: {
          playerId: player1.playerId,
          playerName: player1.userName
        },
        player2: {
          playerId: player2.playerId,
          playerName: player2.userName
        },
        courtNumber: courtNumber.toString(),
        matchStartTime: matchDateTime,
        bracketPosition: `R1-M${matchCounter}`,
        status: "SCHEDULED"
      };

      matches.push(match);
      matchCounter++;
    }

    // Create placeholder matches for subsequent rounds
    let currentRoundMatches = matches.length;
    for (let round = 2; round <= rounds; round++) {
      const nextRoundMatches = currentRoundMatches / 2;

      for (let i = 1; i <= nextRoundMatches; i++) {
        const matchDateTime = new Date(`${startDate}T${startTime}`);
        matchDateTime.setMinutes(matchDateTime.getMinutes() + (matchCounter - 1) * intervalMinutes);

        const match = {
          tournamentId,
          matchId: `DK-${tournamentId}-${matchCounter}`,
          round: getRoundName(playerCount, round),
          roundNumber: round,
          matchNumber: i,
          player1: {
            playerId: null,
            playerName: "TBD"
          },
          player2: {
            playerId: null,
            playerName: "TBD"
          },
          courtNumber: courtNumber.toString(),
          matchStartTime: matchDateTime,
          bracketPosition: `R${round}-M${i}`,
          status: "SCHEDULED"
        };

        matches.push(match);
        matchCounter++;
      }

      currentRoundMatches = nextRoundMatches;
    }

    // Save matches to database
    const createdMatches = await DirectKnockoutMatch.insertMany(matches);

    // Update tournament status
    await Tournament.findByIdAndUpdate(tournamentId, {
      $set: {
        'stageConfig.directKnockout.status': 'matches_created',
        'stageConfig.directKnockout.createdAt': new Date()
      }
    });

    res.json({
      success: true,
      message: "Direct knockout matches created successfully",
      bracket: {
        totalMatches: createdMatches.length,
        rounds: rounds,
        playerCount: playerCount
      },
      matches: createdMatches
    });

  } catch (error) {
    console.error("Error creating direct knockout matches:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create direct knockout matches",
      error: error.message
    });
  }
};

// Get direct knockout matches
exports.getDirectKnockoutMatches = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { sportId } = req.query;

    // Multi-sport: strict sportId match.
    const filter = sportId ? { tournamentId, sportId } : { tournamentId };
    const matches = await DirectKnockoutMatch.find(filter)
      .populate('player1.playerId', 'name profileImage')
      .populate('player2.playerId', 'name profileImage')
      .sort({ roundNumber: 1, matchNumber: 1 });

    res.json({
      success: true,
      matches: matches
    });

  } catch (error) {
    console.error("Error fetching direct knockout matches:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch direct knockout matches",
      error: error.message
    });
  }
};

// Helper function to get round names
function getRoundName(playerCount, roundNumber) {
  const rounds = Math.log2(playerCount);

  if (roundNumber === rounds) return "final";
  if (roundNumber === rounds - 1) return "semi-final";
  if (roundNumber === rounds - 2) return "quarter-final";
  // Dynamic round naming for any bracket size
  const roundsFromEnd = rounds - roundNumber + 1;
  const playersInRound = Math.pow(2, roundsFromEnd);
  return `round-of-${playersInRound}`;
}

// Get groups without matches
exports.getGroupsWithoutMatches = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    if (!tournamentId) {
      return res.status(400).json({
        success: false,
        message: "Tournament ID is required"
      });
    }

    // Import models
    const BookingGroup = require("../src/modules/tournaments/models/bookinggroup");
    const Match = require("../src/modules/tournaments/models/Tournnamentmatch");

    // Get all groups for the tournament
    const allGroups = await BookingGroup.find({ tournamentId })
      .populate({
        path: "players",
        populate: {
          path: "userId",
          select: "name profileImage",
        },
      });

    // Get all matches for the tournament
    const allMatches = await Match.find({ tournamentId }).select('groupId');

    // Extract unique group IDs that have matches
    const groupIdsWithMatches = [...new Set(allMatches.map(match => match.groupId.toString()))];

    // Filter groups that don't have any matches
    const groupsWithoutMatches = allGroups.filter(group =>
      !groupIdsWithMatches.includes(group._id.toString())
    );

    res.status(200).json({
      success: true,
      message: "Groups without matches retrieved successfully",
      data: {
        groupsWithoutMatches,
        count: groupsWithoutMatches.length
      }
    });

  } catch (error) {
    console.error("Error fetching groups without matches:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch groups without matches",
      error: error.message
    });
  }
};

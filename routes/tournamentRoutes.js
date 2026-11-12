const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const Match = require("../src/modules/tournaments/models/Tournnamentmatch");
const tournamentController = require("../controllers/tournamentController");
const exportController = require("../controllers/exportController");
const bookingController = require("../controllers/BookingController");
const attendanceController = require("../controllers/attendanceController");
const bookingGroupController = require("../controllers/booking groupcontroller");
const matchController = require("../controllers/matchController");
const knockoutController = require("../controllers/knockoutController");
const groupStageScoreboardController = require("../controllers/groupStageScoreboardController");
const directKnockoutController = require("../controllers/directKnockoutController");
const swissController = require("../controllers/swissController");
const courtController = require("../controllers/courtController");
const { uploadMiddleware } = require("../middleware/uploads");

const {
  createTopPlayerGroup,
  getTopPlayerGroups,
} = require("../controllers/topPlayerGroupsController");
const KnockoutMatch = require("../src/modules/tournaments/models/semifinal");
const teamKnockoutController = require("../controllers/teamKnockoutController");
const tournamentLeaderboardController = require("../controllers/tournamentLeaderboardController");
const { allowUserOrManager, authenticate } = require("../middleware/authMiddleware");
const { requireTournamentOwner, scopeTournamentCreate, forceSelfBody, requireSelf } = require("../middleware/authz");
const { requirePermission } = require("../middleware/rbacMiddleware");

// Ownership guard for routes that carry tournamentId in the BODY (not the path).
// Closes cross-tenant IDOR: previously a manager with the permission could pass
// ANY tournamentId in the body and manage/score a tournament they don't own.
// (Routes with :matchId are already scoped by the router.param("matchId") guard.)
const ownsBodyTournament = requireTournamentOwner({ idBody: "tournamentId" });

// Same guard for routes that carry the id in the PATH as :tournamentId
// (the attendance routes below). The default idParam is "id".
const ownsParamTournament = requireTournamentOwner({ idParam: "tournamentId" });

// ── Auth gate ─────────────────────────────────────────────────────────
// Every state-changing tournament route (create/edit/delete/score/group/court/
// knockout/etc.) requires a logged-in user or manager. All web + mobile clients
// attach a token via their axios interceptors, so only ANONYMOUS callers are
// blocked. Public GET reads — catalog, detail, leaderboards, and live match-state
// for spectators — remain open. Per-tournament OWNERSHIP is layered per-route
// below (requireTournamentOwner) on routes that carry a :tournamentId.
//
// RBAC (requirePermission) is layered ON TOP of these guards — it gates by
// role+permission, not by ownership. SuperAdmin bypasses both.
router.use((req, res, next) => {
  if (req.method === "GET") return next();
  return allowUserOrManager(req, res, next);
});

// ── Match-write scorer guard ─────────────────────────────────────────
// For ANY non-GET route that carries `:matchId`, the caller must be one of:
//   • a Manager listed on the tournament (Tournament.managerId)
//   • a ClubAdmin who owns one of those Managers (Manager.clubId === caller)
//   • a Referee assigned to this specific match (Assignment.refereeId, accepted)
//   • a SuperAdmin
// Spectator GETs (live-state, scores) skip this. Runs AFTER the gate, so
// req.user/req.userRole are already populated.
router.param("matchId", async (req, res, next, matchId) => {
  if (req.method === "GET") return next();
  try {
    const me = req.user?.id || req.user?._id;
    if (!me) return res.status(401).json({ success: false, message: "Authentication required" });
    if (req.userRole === "SuperAdmin") return next();
    // Direct Knockout matches use custom string IDs (e.g. "DK-<tournamentId>-R1-M2"),
    // not MongoDB ObjectIds. Skip the ObjectId check for those and look them up
    // by their custom matchId field. All other match types still require a valid ObjectId.
    const isDkMatch = typeof matchId === "string" && matchId.startsWith("DK-");
    if (!isDkMatch && !mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json({ success: false, message: "Invalid match id" });
    }
    const { findMatchById } = require("../utils/matchUtils");
    // For DK IDs, findMatchById searches by the custom matchId field (DirectKnockoutMatch.findOne({ matchId })).
    const result = await findMatchById(matchId);
    if (!result) return res.status(404).json({ success: false, message: "Match not found" });
    const tournamentId = result.match?.tournamentId;
    if (!tournamentId) {
      return res.status(403).json({ success: false, message: "Match has no tournament context" });
    }
    const t = await mongoose
      .model("Tournament")
      .findById(tournamentId)
      .select("managerId")
      .lean();
    if (!t) return res.status(404).json({ success: false, message: "Tournament not found" });
    const managerIds = (t.managerId || []).map(String);
    if (managerIds.includes(String(me))) return next();
    const ownsManager = await mongoose
      .model("Manager")
      .exists({ _id: { $in: t.managerId || [] }, clubId: me });
    if (ownsManager) return next();
    // Umpire authorization — use the SAME helper as the client/read-side gate
    // (umpireAuth): authorized via a match-level accepted Assignment OR a
    // stage-level accepted StaffApplication for this tournament. Previously this
    // only checked the per-match Assignment, so stage-granted umpires — who ARE
    // allowed to score and get tap-to-score enabled in the app — were wrongly
    // rejected here with 403 "not a scorer for this match".
    const { isUmpireAuthorizedForMatch } = require("../utils/umpireAuth");
    const umpAuth = await isUmpireAuthorizedForMatch(me, result.match);
    if (umpAuth.authorized) return next();
    return res.status(403).json({ success: false, message: "Forbidden: not a scorer for this match" });
  } catch (err) {
    next(err);
  }
});

//*Create Tournament*//

router.post(
  "/createTournament",
  allowUserOrManager,
  requirePermission("tournament:create"),
  uploadMiddleware.single("tournamentLogo"),
  scopeTournamentCreate,
  tournamentController.createTournament
);
router.get("/", tournamentController.getAllTournaments);

// Batch title/date lookup for the notifications inbox: one request instead of one
// per tournament, and ids that no longer exist are simply absent (no 404 noise).
// Authenticated so the tenant plugin scopes club staff to their own club.
// MUST come before the catch-all `/:id`.
router.get("/summaries", allowUserOrManager, tournamentController.getTournamentSummaries);

// MUST come before the catch-all `/:id`. Legacy pages
// (TournamentOverviewPage, PlayersPage, useGroups, useTournamentDashboard)
// call `/api/tournaments/getRegisteredPlayers?tournamentId=...` but the
// handler was never implemented — every call fell into `/:id` and threw
// a CastError trying to cast "getRegisteredPlayers" to an ObjectId.
// Implements the contract the legacy code expects: `{ bookings: [...] }`.
router.get("/getRegisteredPlayers", async (req, res) => {
  try {
    const { tournamentId } = req.query;
    if (!tournamentId) {
      return res.status(400).json({ message: "tournamentId is required", bookings: [] });
    }
    const Booking = require("../src/modules/tournaments/models/BookingModel");
    const bookings = await Booking.find({ tournamentId }).lean();
    return res.json({ bookings });
  } catch (err) {
    console.error("getRegisteredPlayers error:", err.message);
    return res.status(500).json({ message: "Failed to fetch registered players", bookings: [] });
  }
});

router.get("/manager/:managerId", tournamentController.getTournamentsByManager);
// 🚀 New Corporate specific routes
router.get("/corporate/:corporateId", tournamentController.getTournamentsByCorporate);
// "Mark as completed": moves every sport track to the completed stage.
router.patch(
  "/:tournamentId/complete",
  allowUserOrManager,
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.completeTournament
);
router.put(
  "/:tournamentId/whitelist",
  allowUserOrManager,
  requirePermission("tournament:update"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.updateTournamentWhitelist
);

// ── Reports & Export (manager downloads participants / results) ──
router.get(
  "/:tournamentId/export/participants.csv",
  allowUserOrManager,
  requirePermission("tournament:export"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  exportController.exportParticipantsCsv
);
router.get(
  "/:tournamentId/export/results.csv",
  allowUserOrManager,
  requirePermission("tournament:export"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  exportController.exportResultsCsv
);
router.get(
  "/:tournamentId/export/results.xlsx",
  allowUserOrManager,
  requirePermission("tournament:export"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  exportController.exportResultsXlsx
);
router.get(
  "/:tournamentId/export/results.pdf",
  allowUserOrManager,
  requirePermission("tournament:export"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  exportController.exportResultsPdf
);

router.put(
  "/edit/:id",
  allowUserOrManager,
  requirePermission("tournament:update"),
  requireTournamentOwner({ idParam: "id" }),
  uploadMiddleware.single("tournamentLogo"),
  tournamentController.editTournament
);
router.delete(
  "/:id",
  allowUserOrManager,
  requirePermission("tournament:delete"),
  requireTournamentOwner({ idParam: "id" }),
  tournamentController.deleteTournament
);

//*TOURNAMENT-DAY ATTENDANCE / CHECK-IN*//
//
// Solves "53 registered, 22 turned up": the draw is built from who is PRESENT.
// Reads are open to any authenticated principal (a player needs to see their
// own status); every write that affects someone ELSE requires tournament:manage
// and tournament ownership. Self check-in is the one write a player may do, and
// the controller restricts it to their own booking and to "checked_in" only.
router.get("/:tournamentId/attendance", allowUserOrManager, attendanceController.getRoster);
router.get("/:tournamentId/attendance/summary", allowUserOrManager, attendanceController.getSummary);
router.get("/:tournamentId/attendance/me", allowUserOrManager, attendanceController.getMyAttendance);

router.post(
  "/:tournamentId/attendance/self",
  allowUserOrManager,
  attendanceController.selfCheckIn
);

router.post(
  "/:tournamentId/attendance/mark",
  requirePermission("tournament:manage"),
  ownsParamTournament,
  attendanceController.markAttendance
);
router.post(
  "/:tournamentId/attendance/bulk",
  requirePermission("tournament:manage"),
  ownsParamTournament,
  attendanceController.bulkMarkAttendance
);
router.post(
  "/:tournamentId/attendance/mark-remaining",
  requirePermission("tournament:manage"),
  ownsParamTournament,
  attendanceController.markRemaining
);
router.post(
  "/:tournamentId/attendance/walk-in",
  requirePermission("tournament:bulk_register"),
  ownsParamTournament,
  attendanceController.registerWalkIn
);

//*ROUND 2 PROGRESSION ROUTES*//
router.get("/round2/status/:tournamentId", tournamentController.getRound2Status);
router.post("/round2/initiate", requirePermission("tournament:manage"), ownsBodyTournament, tournamentController.initiateRound2);
router.post("/round2/create-groups", requirePermission("tournament:manage"), ownsBodyTournament, tournamentController.createRound2Groups);
router.get("/round2/groups/:tournamentId", tournamentController.getRound2Groups);
router.post("/round2/reset", requirePermission("tournament:manage"), ownsBodyTournament, tournamentController.resetRound2Progress);
router.post("/superplayers/identify", requirePermission("tournament:manage"), ownsBodyTournament, tournamentController.identifySuperPlayers);
router.get("/superplayers/:tournamentId", tournamentController.getSuperPlayers);
router.post(
  "/cleanup/superplayers-from-topplayers/:tournamentId",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.cleanupSuperPlayersFromTopPlayers
);
router.post(
  "/cleanup/aggressive-superplayers/:tournamentId",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.aggressiveCleanupSuperPlayers
);

//*SUPER PLAYERS KNOCKOUT ROUTES*//
router.post("/knockout/generate", requirePermission("tournament:manage"), ownsBodyTournament, tournamentController.generateKnockoutMatches);
router.delete(
  "/knockout/:tournamentId/all",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.deleteAllKnockoutMatches
);
router.get("/knockout/matches/:tournamentId", tournamentController.getKnockoutMatches);
router.post(
  "/knockout/redistribute-courts/:tournamentId",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.redistributeKnockoutCourts
);
router.put("/knockout/match/:matchId/result", requirePermission("tournament:score"), tournamentController.updateKnockoutMatchResult);
router.get("/knockout/leaderboard/:tournamentId", tournamentController.getTournamentLeaderboard);
router.get("/comprehensive-stats/:tournamentId", tournamentController.getComprehensiveTournamentStats);

// Tournament Leaderboard routes (mobile client)
router.get("/leaderboard/all", tournamentLeaderboardController.getAllTournamentsWithLeaderboard);
router.get("/leaderboard/:tournamentId/players", tournamentLeaderboardController.getGroupStagePlayersLeaderboard);
router.get("/leaderboard/:tournamentId/teams", tournamentLeaderboardController.getKnockoutTeamsLeaderboard);



// Validate player selection for Direct Knockout (power-of-2 check)
router.post(
  "/direct-knockout/validate-players",
  requirePermission("tournament:manage"),
  ownsBodyTournament,
  directKnockoutController.validatePlayerSelection
);

// Create Direct Knockout matches with bracket generation
router.post(
  "/direct-knockout/create-matches",
  requirePermission("tournament:manage"),
  ownsBodyTournament,
  directKnockoutController.createDirectKnockoutMatches
);

// Get all Direct Knockout matches for a tournament
router.get(
  "/direct-knockout/:tournamentId/matches",
  directKnockoutController.getDirectKnockoutMatches
);

// Progress winner to next match in bracket
router.post(
  "/direct-knockout/matches/:matchId/progress-winner",
  requirePermission("tournament:manage"),
  directKnockoutController.progressWinnerToNextMatch
);

// Standalone mode — no group stage needed
router.post(
  "/direct-knockout/standalone/validate",
  requirePermission("tournament:manage"),
  directKnockoutController.validateStandalonePlayers
);
router.post(
  "/direct-knockout/standalone/create",
  requirePermission("tournament:manage"),
  ownsBodyTournament,
  directKnockoutController.createStandaloneKnockout
);

// Live scoring for Direct Knockout
router.post(
  "/direct-knockout/matches/:matchId/complete-game",
  allowUserOrManager,
  requirePermission("tournament:score"),
  directKnockoutController.completeGame
);

// Give BYE to a player in a match
router.post(
  "/direct-knockout/matches/:matchId/bye",
  requirePermission("tournament:manage"),
  directKnockoutController.giveBye
);

// Reopen a completed match so its score can be corrected. Retracts the winner
// from the next round; pass { cascade: true } to also clear later matches that
// were played on the back of this result. Ownership is enforced by the
// router.param("matchId") scorer guard above.
router.post(
  "/direct-knockout/matches/:matchId/reopen",
  requirePermission("tournament:manage"),
  directKnockoutController.reopenMatch
);

// Edit player name in a match (label only — does NOT move playerId)
router.put(
  "/direct-knockout/matches/:matchId/player-name",
  requirePermission("tournament:manage"),
  directKnockoutController.updatePlayerName
);

// Swap two players between bracket slots (drag-and-drop on the bracket).
//
// Deliberately a separate endpoint from player-name: this moves the WHOLE slot
// including playerId, because progression and result attribution key on the id.
// Reusing the rename endpoint for a swap would leave the bracket showing one
// player while the engine advanced another.
//
// :matchId is the SOURCE match, so the router.param("matchId") guard authorises
// the source tournament; the controller then requires the target match to be in
// that same tournament.
router.put(
  "/direct-knockout/matches/:matchId/swap-player",
  requirePermission("tournament:manage"),
  directKnockoutController.swapPlayers
);

// Bulk score upload for Direct Knockout
router.post(
  "/direct-knockout/bulk-upload-scores",
  requirePermission("tournament:score"),
  ownsBodyTournament,
  directKnockoutController.bulkUploadScores
);

//*SWISS SYSTEM ROUTES*//
// Fixed number of rounds, nobody eliminated, standings decide the result.
// Rounds are generated one at a time because round N's pairings depend on
// round N-1's results. Keyed by tournament, so ownership is enforced with the
// explicit tournament-owner guard.
router.post(
  "/swiss/:tournamentId/start",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  swissController.startSwissEvent
);
router.post(
  "/swiss/:tournamentId/next-round",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  swissController.generateNextRound
);
// Read-only: spectators and players may view rounds and standings.
router.get("/swiss/:tournamentId", swissController.getSwissEvent);
router.delete(
  "/swiss/:tournamentId",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  swissController.resetSwissEvent
);

// Third-place play-off — create between the two semi-final losers, or remove it
// again while unplayed. Keyed by tournament (not matchId), so ownership needs
// the explicit tournament-owner guard.
router.post(
  "/direct-knockout/:tournamentId/third-place",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  directKnockoutController.createThirdPlaceMatch
);
router.delete(
  "/direct-knockout/:tournamentId/third-place",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  directKnockoutController.deleteThirdPlaceMatch
);

// Reset bracket
router.delete(
  "/direct-knockout/:tournamentId/reset",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  directKnockoutController.resetBracket
);

//*GROUP STAGE TOURNAMENT ROUTES*//
//*Registred Players*//

// forceSelfBody: a player can only register THEMSELVES (the gate auth is upstream).
// Manager bulk-registration uses the separate /bookings/bulk-create route.
router.post(
  "/bookings/create",
  requirePermission("tournament:register"),
  forceSelfBody("userId"),
  bookingController.createBooking
);
router.post(
  "/bookings/bulk-create",
  requirePermission("tournament:bulk_register"),
  bookingController.bulkCreateBookings
);
router.get("/bookings/check", bookingController.checkBooking);
router.get("/bookings/user/:userId", authenticate, requireSelf("userId"), bookingController.getUserBookings);
router.get(
  "/bookings/tournament/:tournamentId",
  bookingController.getTournamentBookings
);


//*League Group*//

router.post("/bookinggroups/create", requirePermission("tournament:manage"), ownsBodyTournament, bookingGroupController.createBookingGroup);
router.get(
  "/bookinggroups/tournament/:tournamentId",
  bookingGroupController.getBookingGroups
);
router.put(
  "/bookinggroups/:groupId",
  requirePermission("tournament:manage"),
  bookingGroupController.updateBookingGroup
);
router.delete(
  "/bookinggroups/:groupId",
  requirePermission("tournament:manage"),
  bookingGroupController.deleteBookingGroup
);
// Bulk delete — body: { groupIds: [] }. Cascades matches per group, blocks
// (per-group 409 in the response payload) when a group has completed matches
// AND its sport has progressed past group_stage. Sub-step Plan A.
router.post(
  "/bookinggroups/bulk-delete",
  requirePermission("tournament:manage"),
  bookingGroupController.deleteBulkBookingGroups
);

// 🚀 Court / table catalog (Sub-step 1 of court management).
// v1: tournament-wide pool (sportId nullable on each entry). Soft-delete only.
router.get   ("/:tournamentId/courts",          courtController.listCourts);
router.post  (
  "/:tournamentId/courts",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  courtController.createCourt
);
// Static-segment routes MUST be registered before /:courtId so that
// "bulk" / "utilization" don't get matched as a courtId parameter.
router.post  (
  "/:tournamentId/courts/bulk",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  courtController.bulkCreateCourts
);
router.get   ("/:tournamentId/courts/utilization", courtController.getCourtUtilization);
// Round-robin existing matches across the active courts (fixes matches
// generated before courts were created / renamed).
router.post  (
  "/:tournamentId/courts/distribute",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  courtController.distributeMatchesToCourts
);
router.put   (
  "/:tournamentId/courts/:courtId",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  courtController.updateCourt
);
// Assign / unassign the umpire responsible for a court (one umpire per court).
router.patch (
  "/:tournamentId/courts/:courtId/umpire",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  courtController.assignUmpireToCourt
);
router.delete(
  "/:tournamentId/courts/:courtId",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  courtController.deleteCourt
);

// 🚀 Group-specific match format routes
router.get(
  "/bookinggroups/:groupId/match-format",
  bookingGroupController.getGroupMatchFormat
);
router.put(
  "/bookinggroups/:groupId/match-format",
  requirePermission("tournament:manage"),
  bookingGroupController.updateGroupMatchFormat
);

//*Matches*//

router.post("/matches/create", requirePermission("tournament:manage"), ownsBodyTournament, matchController.createMatches);
router.post("/matches/generate-group", requirePermission("tournament:manage"), ownsBodyTournament, matchController.generateGroupMatches);
// Bulk generate — body: { tournamentId, groupIds: [], courtNumber?, startTime?,
// intervalMinutes? }. Iterates server-side; skipped groups (already have
// matches) are reported in the response, not failed. Sub-step Plan A.
router.post("/matches/generate-bulk", requirePermission("tournament:manage"), ownsBodyTournament, matchController.generateBulkGroupMatches);
router.post("/matches/transition-to-knockout", requirePermission("tournament:manage"), ownsBodyTournament, matchController.transitionToKnockout);

//*GROUP STAGE SCOREBOARD ROUTES (Must come before general match routes)*//

// Start match and initialize scoreboard
router.post("/matches/:matchId/start", requirePermission("tournament:score"), groupStageScoreboardController.startMatch);

// Get live match state (for scoreboard UI)
router.get("/matches/:matchId/live-state", groupStageScoreboardController.getLiveMatchState);

// Get match scores (array format for compatibility)
router.get("/matches/:matchId/scores", groupStageScoreboardController.getMatchScores);

// Get single score (alternative endpoint)
router.get("/scores/:matchId", groupStageScoreboardController.getMatchScore);

// Update live score during game
router.put("/matches/:matchId/live-score", requirePermission("tournament:score"), groupStageScoreboardController.updateLiveScore);

// Complete current game and progress match
router.post(
  "/matches/:matchId/complete-game",
  allowUserOrManager,
  requirePermission("tournament:score"),
  groupStageScoreboardController.completeGame
);

// ── Cricket (innings) incremental scoring ──
router.post("/matches/:matchId/cricket/setup", allowUserOrManager, requirePermission("tournament:score"), groupStageScoreboardController.setupCricketInnings);
router.post("/matches/:matchId/cricket/lineup", allowUserOrManager, requirePermission("tournament:score"), groupStageScoreboardController.updateCricketLineup);
router.post("/matches/:matchId/cricket/ball", allowUserOrManager, requirePermission("tournament:score"), groupStageScoreboardController.submitCricketBall);
router.post("/matches/:matchId/cricket/undo", allowUserOrManager, requirePermission("tournament:score"), groupStageScoreboardController.undoCricketBall);
router.post("/matches/:matchId/cricket/innings-switch", allowUserOrManager, requirePermission("tournament:score"), groupStageScoreboardController.switchCricketInnings);
router.post("/matches/:matchId/cricket/finish", allowUserOrManager, requirePermission("tournament:score"), groupStageScoreboardController.finishCricketMatch);

// ── Carrom (board) incremental scoring ──
router.post("/matches/:matchId/carrom/board", allowUserOrManager, requirePermission("tournament:score"), groupStageScoreboardController.submitCarromBoard);

// Reset match (admin function)
router.post("/matches/:matchId/reset", requirePermission("tournament:manage"), groupStageScoreboardController.resetMatch);

// Get match statistics
router.get("/matches/:matchId/statistics", groupStageScoreboardController.getMatchStatistics);

// Sync live match data to Score model for points table compatibility
router.post("/matches/:matchId/sync-scores", requirePermission("tournament:score"), groupStageScoreboardController.syncMatchScores);

// Bulk sync all tournament matches to Score model (for already played matches)
router.post(
  "/:tournamentId/bulk-sync-scores",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  groupStageScoreboardController.bulkSyncTournamentScores
);

// Bulk upload set scores for multiple matches at once
router.post("/matches/bulk-upload-scores", requirePermission("tournament:score"), ownsBodyTournament, groupStageScoreboardController.bulkUploadScores);

// 🚀 VALIDATION ENDPOINT - Test game completion logic fix
router.get("/validate/game-completion-logic", groupStageScoreboardController.validateGameCompletionLogic);

// Group Standings
router.get("/standings/:tournamentId/:groupId", groupStageScoreboardController.getGroupStandings);

// DEBUG: Check tournament matches data
router.get("/:tournamentId/debug-matches", async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const Match = require("../src/modules/tournaments/models/Tournnamentmatch");

    const matches = await Match.find({ tournamentId });

    const debug = matches.map(match => ({
      id: match._id,
      status: match.status,
      player1: match.player1?.userName,
      player2: match.player2?.userName,
      setsCount: match.sets?.length || 0,
      setsData: match.sets?.map(set => ({
        status: set.status,
        gamesCount: set.games?.length || 0,
        completedGames: set.games?.filter(g => g.status === 'COMPLETED').length || 0
      }))
    }));

    res.json({
      tournamentId,
      totalMatches: matches.length,
      matches: debug
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IMPORTANT: Score-related routes must come BEFORE the general /:tournamentId/:groupId route
// Points Table specific route - returns array of scores for frontend compatibility (duplicate removed - already defined above)

// General match routes (must come after specific routes)
router.get(
  "/matches/:tournamentId/:groupId",
  matchController.getMatchesByGroup
);
router.put("/matches/:matchId", requirePermission("tournament:score"), matchController.updateMatch);
// Sub-step 5 — inline court reassignment. Multi-collection: looks up the
// match across Match / SuperMatch / DirectKnockoutMatch / KnockoutMatch /
// TeamKnockoutMatches and updates whichever holds the id.
router.patch("/matches/:matchId/court", requirePermission("tournament:manage"), matchController.updateMatchCourt);
router.delete("/matches/:matchId", requirePermission("tournament:manage"), matchController.deleteMatch);
router.delete(
  "/matches/:tournamentId/:groupId/all",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  matchController.deleteGroupMatches
);

//* Match Configuration *//

// 🚀 Get available match format options (for UI dropdowns)
router.get("/match-format-options", tournamentController.getMatchFormatOptions);

// Get tournament match format configuration
router.get("/:tournamentId/match-format", tournamentController.getTournamentMatchFormat);

// Update tournament match format configuration
router.put(
  "/:tournamentId/match-format",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.updateTournamentMatchFormat
);

// Get specific match configuration (inherits from tournament)
router.get("/matches/:matchId/format", tournamentController.getMatchFormat);

// Update specific match configuration (override tournament defaults)
router.put("/matches/:matchId/format", requirePermission("tournament:manage"), tournamentController.updateMatchFormat);

//*Scores*//

router.post("/scores/:matchId", requirePermission("tournament:score"), tournamentController.createScore);
router.get("/scores/:matchId", tournamentController.getScoreByMatchId);
router.put('/scores/:matchId', requirePermission("tournament:score"), tournamentController.updateScoreByMatchId);
router.delete('/scores/:matchId', requirePermission("tournament:score"), tournamentController.deleteScoreByMatchId);



router.get("/:id", tournamentController.getTournamentById);



// Example Express route
router.get("/referee/matches/:refereeId", async (req, res) => {
  const { refereeId } = req.params;
  try {
    const matches = await Match.find({ "referee.refereeId": refereeId });

    res.status(200).json({ matches });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});


router.post("/top-player-groups", requirePermission("tournament:manage"), ownsBodyTournament, createTopPlayerGroup);
router.get("/top-player-groups/:tournamentId", getTopPlayerGroups);

// Get super matches for a tournament
router.get("/super-matches/:tournamentId", tournamentController.getSuperPlayers);
router.post("/superplayers/save", requirePermission("tournament:manage"), ownsBodyTournament, tournamentController.saveSuperPlayers);


// routes/bookingRoutes.js (new controller bookingGroup)
router.post("/bookinggroups/create", requirePermission("tournament:manage"), ownsBodyTournament, bookingGroupController.createBookingGroup);
router.get(
  "/bookinggroups/tournament/:tournamentId",
  bookingGroupController.getBookingGroups
);

router.post("/topplayers/save", requirePermission("tournament:manage"), ownsBodyTournament, tournamentController.saveTopPlayers);

router.get("/topplayers/:tournamentId/:groupId", tournamentController.getTopPlayersByGroup);

router.get("/topplayers/:tournamentId", tournamentController.getTopPlayersByTournament);

router.delete(
  "/topplayers/:tournamentId/:groupId/player/:playerId",
  requirePermission("tournament:manage"),
  tournamentController.removeTopPlayer
);

// Toggle skip-Round-2 flag on a Top Player (seeds them for the final KO)
router.post(
  "/topplayers/:tournamentId/skip-round2",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.toggleSkipRound2
);

//*TOURNAMENT PROGRESSION ROUTES*//

// Seeded Players Management
router.post(
  "/:tournamentId/seeded-players",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  tournamentController.addSeededPlayers
);

// Tournament Stage Progression
// QUARANTINED (2026-06-20): the legacy KnockoutMatch-based group→knockout path
// (generateQualifierKnockout / generateMainKnockout → generateKnockoutBracket)
// is dead and broken — it never wires nextMatch.matchId, so winners never
// auto-advance, and generateNextRound re-pairs winners by array order, losing
// bracket position. The web client uses the live SuperMatch path
// (/api/tournaments/knockout/generate) instead. Routes disabled so they 404;
// controllers + Modal/KnockoutMatch.js are kept one release, then deleted.
// router.post("/:tournamentId/generate-qualifier-knockout", requirePermission("tournament:manage"), requireTournamentOwner({ idParam: "tournamentId" }), tournamentController.generateQualifierKnockout);
// router.post("/:tournamentId/generate-main-knockout", requirePermission("tournament:manage"), requireTournamentOwner({ idParam: "tournamentId" }), tournamentController.generateMainKnockout);

// Tournament Status and Progression
router.get("/:tournamentId/progression", tournamentController.getTournamentProgression);

//*KNOCKOUT MATCH MANAGEMENT ROUTES*//

// Get knockout matches
router.get("/:tournamentId/knockout-matches", knockoutController.getKnockoutMatches);
router.get("/knockout-matches/:matchId", knockoutController.getKnockoutMatchById);

// Update match results
router.put("/knockout-matches/:matchId/result", requirePermission("tournament:score"), knockoutController.updateKnockoutMatchResult);

// Generate next round
router.post(
  "/:tournamentId/generate-next-round",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  knockoutController.generateNextRound
);

// Get tournament bracket
router.get("/:tournamentId/bracket", knockoutController.getTournamentBracket);


// Update your knockout matches route
// Update your knockout matches route
router.post("/knockout-matches", requirePermission("tournament:manage"), async (req, res) => {
  try {
    const { tournamentId, matches } = req.body;

    // Validate input
    if (!tournamentId || !matches || !Array.isArray(matches)) {
      return res.status(400).json({
        success: false,
        message: "Invalid request data",
      });
    }

    // Format matches with required fields and proper date handling
    const formattedMatches = matches.map((match) => {
      // Parse the date and time strings correctly
      const [time, period] = match.time.split(" ");
      const [hours, minutes] = time.split(":");
      let hour = parseInt(hours);

      // Convert to 24-hour format if needed
      if (period === "PM" && hour !== 12) {
        hour += 12;
      } else if (period === "AM" && hour === 12) {
        hour = 0;
      }

      // Create a new Date object with the correct date and time
      const matchDateTime = new Date(match.date);
      matchDateTime.setHours(hour);
      matchDateTime.setMinutes(parseInt(minutes));
      matchDateTime.setSeconds(0);
      matchDateTime.setMilliseconds(0);

      // Create the formatted match object
      return {
        tournamentId,
        title: match.title,
        matchStage: match.matchStage || "knockout",
        date: match.date,
        time: match.time,
        selectedCourt: match.selectedCourt,
        teams: match.teams,
        status: "scheduled",
        roundNumber: match.roundNumber || 1,
        matchNumber: match.matchNumber,
        reminder: {
          isEnabled: true,
          reminderTime: matchDateTime, // Now using properly formatted Date object
        },
      };
    });

    // Debug log to verify the formatted matches
    console.log(
      "Formatted matches with correct dates:",
      formattedMatches.map((m) => ({
        ...m,
        reminder: {
          ...m.reminder,
          reminderTime: m.reminder.reminderTime.toISOString(),
        },
      }))
    );

    // Create matches
    const createdMatches = await KnockoutMatch.insertMany(formattedMatches);

    res.json({
      success: true,
      matches: createdMatches,
    });
  } catch (error) {
    console.error("Error creating knockout matches:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create knockout matches",
      error: error.toString(),
    });
  }
});

// GET endpoint to fetch all knockout matches for a tournament
router.get("/knockout-matches/:tournamentId", async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const matches = await KnockoutMatch.find({ tournamentId }).sort({
      createdAt: -1,
    });

    res.json({
      success: true,
      matches,
    });
  } catch (error) {
    console.error("Error fetching knockout matches:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch knockout matches",
    });
  }
});

// Get groups without matches
router.get("/groups-without-matches/:tournamentId", tournamentController.getGroupsWithoutMatches);

// Get tournament logo
router.get("/:id/logo", tournamentController.getLogo);

// ================================
// TEAM KNOCKOUT ROUTES (NEW SIMPLIFIED CONTROLLER)
// ================================

// Tournament Creation
router.post(
  "/team-knockout/create",
  requirePermission("tournament:manage"),
  ownsBodyTournament,
  teamKnockoutController.createTournamentFromBookings
);

// Round Robin
router.post(
  "/team-knockout/round-robin/generate",
  requirePermission("tournament:manage"),
  ownsBodyTournament,
  teamKnockoutController.generateRoundRobinMatches
);
router.get(
  "/team-knockout/round-robin/standings/:tournamentId",
  teamKnockoutController.getRoundRobinStandings
);
router.post(
  "/team-knockout/round-robin/delete",
  requirePermission("tournament:manage"),
  ownsBodyTournament,
  teamKnockoutController.deleteRoundRobinMatches
);

// Bulk upload scores for team knockout matches
router.post(
  "/team-knockout/bulk-upload-scores",
  requirePermission("tournament:score"),
  ownsBodyTournament,
  teamKnockoutController.bulkUploadScores
);

// Live Scoring
router.get(
  "/team-knockout/matches/:matchId/live-state",
  teamKnockoutController.getLiveMatchState
);
router.put(
  "/team-knockout/matches/:matchId/live-score",
  requirePermission("tournament:score"),
  teamKnockoutController.updateLiveScore
);
router.post(
  "/team-knockout/matches/:matchId/complete-game",
  requirePermission("tournament:score"),
  teamKnockoutController.completeGame
);

// Captain's doubles pairing selection
router.post(
  "/team-knockout/matches/:matchId/select-pairing",
  requirePermission("tournament:score"),
  teamKnockoutController.selectDoublesPairing
);

// Rapid Rallies — captain's dynamic pick (doubles partner / rubber-5 player)
router.post(
  "/team-knockout/matches/:matchId/rapid-rallies-pick",
  requirePermission("tournament:score"),
  teamKnockoutController.selectRapidRalliesPick
);

// Rapid Rallies — legal picks per side/rubber (for the manager lineup UI)
router.get(
  "/team-knockout/matches/:matchId/rapid-rallies-options",
  requirePermission("tournament:score"),
  teamKnockoutController.getRapidRalliesOptions
);

// Rapid Rallies — register/update a team with a full 5-slot roster (+ gender)
router.post(
  "/team-knockout/rapid-rallies/register-team",
  requirePermission("tournament:manage"),
  teamKnockoutController.registerRapidRalliesTeam
);

// Match Queries
router.get(
  "/team-knockout/matches/:tournamentId",
  teamKnockoutController.getMatchesByTournament
);
router.get(
  "/team-knockout/matches-by-round",
  teamKnockoutController.getMatchesByRound
);
router.get(
  "/:tournamentId/matches-by-tournament",
  teamKnockoutController.getMatchesByTournament
);
router.get(
  "/team-knockout/match/:matchId",
  teamKnockoutController.getMatchById
);

// Next Round Generation
router.post(
  "/team-knockout/next-round",
  requirePermission("tournament:manage"),
  ownsBodyTournament,
  teamKnockoutController.createNextRound
);

// Team Management
router.get(
  "/team-knockout/teams/:tournamentId",
  teamKnockoutController.getTeamsByTournament
);

// Player Substitutions
router.post(
  "/team-knockout/teams/:teamId/swap-players",
  requirePermission("tournament:manage"),
  teamKnockoutController.swapTeamPlayers
);

router.post(
  "/team-knockout/matches/:matchId/substitute",
  requirePermission("tournament:manage"),
  teamKnockoutController.updateMatchLineup
);

// Utility Functions
router.post(
  "/team-knockout/matches/:matchId/start",
  requirePermission("tournament:score"),
  teamKnockoutController.startMatch
);
router.put(
  "/team-knockout/matches/:matchId/reschedule",
  requirePermission("tournament:manage"),
  teamKnockoutController.rescheduleMatch
);
router.put(
  "/team-knockout/matches/:matchId/cancel",
  requirePermission("tournament:manage"),
  teamKnockoutController.cancelMatch
);

// Statistics
router.get(
  "/team-knockout/tournaments/:tournamentId/stats",
  teamKnockoutController.getTournamentStatistics
);
router.get(
  "/team-knockout/matches/:matchId/stats",
  teamKnockoutController.getMatchStatistics
);

// Compatibility Route (IMPORTANT: Keep this for existing frontend)
router.get(
  "/players/bookings/tournament-teams/:tournamentId",
  teamKnockoutController.getBookingTeams
);

// Reset & Health
router.delete(
  "/team-knockout/tournaments/:tournamentId/reset",
  requirePermission("tournament:manage"),
  requireTournamentOwner({ idParam: "tournamentId" }),
  teamKnockoutController.resetTournament
);

// Match Status (for scoreboard initialization)
router.get(
  "/tournaments/match-status/:matchId",
  teamKnockoutController.getMatchById
);

// Live Score Updates (for real-time scoring)
router.patch(
  "/tournaments/matches/:matchId",
  requirePermission("tournament:score"),
  teamKnockoutController.updateLiveScore
);

// Player Substitutions (for scoreboard substitutions)
router.post(
  "/tournaments/matches/:matchId/substitute",
  requirePermission("tournament:manage"),
  teamKnockoutController.substitutePlayer
);

router.get("/team-knockout/health", teamKnockoutController.healthCheck);

// ═══════════════════════════════════════════════════════════════
// BULK RESULT UPLOAD (CSV/Excel file upload)
// ═══════════════════════════════════════════════════════════════
const bulkResultUploadController = require("../controllers/bulkResultUploadController");

// Multer config for result files (CSV/XLSX, max 10MB)
const resultUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../uploads/results");
    const fs = require("fs");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `results-${Date.now()}-${file.originalname}`);
  },
});
const resultUpload = multer({
  storage: resultUploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".csv", ".xlsx", ".xls"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${ext}. Allowed: ${allowed.join(", ")}`));
    }
  },
});

router.post("/bulk-result-upload", requirePermission("tournament:score"), resultUpload.single("file"), bulkResultUploadController.uploadResults);
router.post("/bulk-result-upload/preview", requirePermission("tournament:manage"), resultUpload.single("file"), bulkResultUploadController.previewFile);
router.get("/bulk-result-upload/template", bulkResultUploadController.downloadTemplate);

module.exports = router;

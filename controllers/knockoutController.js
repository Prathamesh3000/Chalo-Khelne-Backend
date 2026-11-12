const KnockoutMatch = require("../src/modules/tournaments/models/KnockoutMatch");
const Tournament = require("../src/modules/tournaments/models/Tournament");
const User = require("../src/modules/identity/models/User");
const mongoose = require("mongoose");
const { createLegacyKnockoutMatch } = require("../factories/MatchFactory");
const { assertSportInTournament, handleSportContextError } = require("../middleware/requireSportContext");

// Get knockout matches by tournament and type
exports.getKnockoutMatches = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { matchType, round, category, sportId } = req.query;

    let query = { tournamentId };

    // STEP 11d — Multi-sport: strict sportId match (post-migration data).
    if (sportId) {
      query.sportId = sportId;
    }
    if (matchType) {
      query.matchType = matchType;
    }
    if (round) {
      query.round = parseInt(round);
    }
    if (category) {
      query.category = category;
    }

    const matches = await KnockoutMatch.find(query)
      .populate('player1.playerId', 'name profileImage playerType')
      .populate('player2.playerId', 'name profileImage playerType')
      .populate('referee.refereeId', 'name profileImage')
      .sort({ round: 1, bracketPosition: 1 });

    res.status(200).json({
      success: true,
      matches,
      total: matches.length
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

// Get specific knockout match by ID
exports.getKnockoutMatchById = async (req, res) => {
  try {
    const { matchId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid match ID"
      });
    }

    const match = await KnockoutMatch.findById(matchId)
      .populate('player1.playerId', 'name profileImage playerType seedRank nationalRanking')
      .populate('player2.playerId', 'name profileImage playerType seedRank nationalRanking')
      .populate('referee.refereeId', 'name profileImage contact')
      .populate('tournamentId', 'title type currentStage');

    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Match not found"
      });
    }

    res.status(200).json({
      success: true,
      match
    });

  } catch (error) {
    console.error("Error fetching knockout match:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch match",
      error: error.message
    });
  }
};

// Update knockout match result
exports.updateKnockoutMatchResult = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { winnerId, status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid match ID"
      });
    }

    const match = await KnockoutMatch.findById(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Match not found"
      });
    }

    // Validate winner
    const isPlayer1 = match.player1.playerId.toString() === winnerId;
    const isPlayer2 = match.player2.playerId.toString() === winnerId;

    if (!isPlayer1 && !isPlayer2) {
      return res.status(400).json({
        success: false,
        message: "Winner must be one of the match participants"
      });
    }

    // Update match result
    const winner = isPlayer1 ? match.player1 : match.player2;

    match.winner = {
      playerId: winner.playerId,
      playerName: winner.playerName,
      playerType: winner.playerType
    };
    match.status = status || "COMPLETED";
    match.updatedAt = new Date();

    await match.save({ validateModifiedOnly: true });

    // If this match has a nextMatch reference, update that match
    if (match.nextMatch && match.nextMatch.matchId) {
      await updateNextRoundMatch(match.nextMatch.matchId, match.nextMatch.position, winner);
    }

    res.status(200).json({
      success: true,
      message: "Match result updated successfully",
      match
    });

  } catch (error) {
    console.error("Error updating knockout match result:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update match result",
      error: error.message
    });
  }
};

// Helper function to update next round match with winner
const updateNextRoundMatch = async (nextMatchId, position, winner) => {
  try {
    const nextMatch = await KnockoutMatch.findById(nextMatchId);
    if (!nextMatch) return;

    const updateField = position === "player1" ? "player1" : "player2";

    nextMatch[updateField] = {
      playerId: winner.playerId,
      playerName: winner.playerName,
      playerType: winner.playerType,
      seedRank: winner.seedRank || null,
      fromGroup: winner.fromGroup || null
    };

    await nextMatch.save({ validateModifiedOnly: true });
    console.log(`Updated ${updateField} in next match ${nextMatchId}`);

  } catch (error) {
    console.error("Error updating next round match:", error);
  }
};

// Generate next round matches
exports.generateNextRound = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { currentRound, matchType, category } = req.body;

    // Get completed matches from current round
    const completedMatches = await KnockoutMatch.find({
      tournamentId,
      matchType,
      round: currentRound,
      status: "COMPLETED",
      category: category || { $exists: true }
    });

    // STEP 16d — derive sportId from the prior round's first match
    // (the new round inherits sport scoping). Fall back to req.body.sportId.
    // If neither resolves, refuse rather than silently picking sports[0].
    let _priorSportId = completedMatches.find((m) => m.sportId)?.sportId
      || req.body.sportId
      || null;
    {
      const _tForSport = await Tournament.findById(tournamentId).lean();
      try {
        assertSportInTournament(_priorSportId, _tForSport);
      } catch (err) {
        if (handleSportContextError(err, res)) return;
        throw err;
      }
    }

    const winners = completedMatches
      .filter(match => match.winner && match.winner.playerId)
      .map(match => match.winner);

    if (winners.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No winners found in current round"
      });
    }

    if (winners.length === 1) {
      // This sport's final is done. Complete its track. (This used to write
      // currentStage/tournamentStatus at the document root, which the schema no
      // longer declares — Mongoose dropped the write, so nothing ever completed.)
      const { setCurrentStage } = require("../utils/sportTrackUtils");
      await setCurrentStage(tournamentId, _priorSportId, "completed");

      return res.status(200).json({
        success: true,
        message: "Tournament completed!",
        champion: winners[0]
      });
    }

    // Generate next round
    const nextRound = currentRound + 1;
    const roundNames = {
      3: "Main Knockout",
      4: "Quarterfinals",
      5: "Semifinals",
      6: "Final"
    };

    // Load tournament for sport config (MatchFactory needs it)
    const tournament = await Tournament.findById(tournamentId);

    // Build ALL next-round match documents first (no DB writes yet) so we can
    // persist them atomically. Previously each match was saved individually in
    // this loop — a crash midway left a partial, corrupt bracket.
    const matchDocs = [];
    let bracketPosition = 1;

    for (let i = 0; i < winners.length; i += 2) {
      const player1 = winners[i];
      const player2 = winners[i + 1];

      if (!player2) {
        // BYE match — odd number of winners
        matchDocs.push(createLegacyKnockoutMatch({
          tournament,
          tournamentId,
          sportId: _priorSportId,
          matchType,
          round: nextRound,
          roundName: roundNames[nextRound] || `Round ${nextRound}`,
          bracketPosition,
          player1: { playerId: player1.playerId, playerName: player1.playerName, playerType: player1.playerType },
          player2: { playerId: new mongoose.Types.ObjectId(), playerName: "BYE", playerType: "general" },
          category: category || "Open",
          status: "BYE",
          isBye: true,
          winner: { playerId: player1.playerId, playerName: player1.playerName, playerType: player1.playerType },
        }));
      } else {
        // Regular match
        matchDocs.push(createLegacyKnockoutMatch({
          tournament,
          tournamentId,
          sportId: _priorSportId,
          matchType,
          round: nextRound,
          roundName: roundNames[nextRound] || `Round ${nextRound}`,
          bracketPosition,
          player1: { playerId: player1.playerId, playerName: player1.playerName, playerType: player1.playerType },
          player2: { playerId: player2.playerId, playerName: player2.playerName, playerType: player2.playerType },
          category: category || "Open",
        }));
      }

      bracketPosition++;
    }

    // Persist atomically — all matches insert together or none (rolls back on
    // any failure, so the bracket is never left half-generated).
    let nextRoundMatches = [];
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        nextRoundMatches = await KnockoutMatch.insertMany(matchDocs, { session });
      });
    } finally {
      session.endSession();
    }

    res.status(201).json({
      success: true,
      message: `Round ${nextRound} matches generated successfully`,
      round: nextRound,
      roundName: roundNames[nextRound] || `Round ${nextRound}`,
      matches: nextRoundMatches,
      totalMatches: nextRoundMatches.length
    });

  } catch (error) {
    console.error("Error generating next round:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate next round",
      error: error.message
    });
  }
};

// Get tournament bracket overview
exports.getTournamentBracket = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: "Tournament not found"
      });
    }

    // Get all knockout matches grouped by round
    const allMatches = await KnockoutMatch.find({ tournamentId })
      .populate('player1.playerId', 'name profileImage playerType')
      .populate('player2.playerId', 'name profileImage playerType')
      .sort({ round: 1, bracketPosition: 1 });

    // Group matches by round and type
    const bracket = {
      qualifierKnockout: {},
      mainKnockout: {}
    };

    allMatches.forEach(match => {
      const roundKey = `round${match.round}`;

      if (!bracket[match.matchType][roundKey]) {
        bracket[match.matchType][roundKey] = {
          round: match.round,
          roundName: match.roundName,
          matches: []
        };
      }

      bracket[match.matchType][roundKey].matches.push(match);
    });

    // STEP 17b.iv — currentStage read off sports[0] (per-sport).
    const { getCurrentStage: _getStage } = require("../utils/sportTrackUtils");
    res.status(200).json({
      success: true,
      tournament: {
        id: tournament._id,
        title: tournament.title,
        currentStage: _getStage(tournament),
        tournamentStatus: tournament.tournamentStatus
      },
      bracket
    });

  } catch (error) {
    console.error("Error fetching tournament bracket:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tournament bracket",
      error: error.message
    });
  }
};

module.exports = {
  getKnockoutMatches: exports.getKnockoutMatches,
  getKnockoutMatchById: exports.getKnockoutMatchById,
  updateKnockoutMatchResult: exports.updateKnockoutMatchResult,
  generateNextRound: exports.generateNextRound,
  getTournamentBracket: exports.getTournamentBracket
};
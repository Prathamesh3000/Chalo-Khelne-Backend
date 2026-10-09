const TeamKnockoutTeams = require("../src/modules/tournaments/models/TeamKnockoutTeams");
const TeamKnockoutMatches = require("../src/modules/tournaments/models/TeamKnockoutMatches");
const TeamKnockout = require("../src/modules/tournaments/models/TeamKnockout");
const Booking = require("../src/modules/tournaments/models/BookingModel");
const Tournament = require("../src/modules/tournaments/models/Tournament");
const mongoose = require("mongoose");
const { getFormat, resolveSetPositions, resolveSetPlayers, needsThirdPlayer } = require("../Config/teamKnockoutFormats");
const { readMatchResult } = require("../utils/matchUtils");
const RRLineup = require("../utils/rapidRalliesLineup");
const {
  slotMapFromTeam,
  genderMapFromTeam,
  buildRapidRalliesSets,
  decideTieOutcome,
} = require("../utils/rapidRalliesTie");

// A team-tie format is "Rapid Rallies" style when it declares playAllSets and a
// 5-slot roster (femaleSlot). Detected from the resolved format config so the
// generator/scoring branch never hard-codes the id.
const isRapidRalliesFormat = (fmt) => !!(fmt && fmt.playAllSets && fmt.femaleSlot);

// ================================
// HELPER FUNCTIONS
// ================================

// Derive formatId from legacy params (backward compat for old tournaments)
const deriveFormatId = (tournamentType, setCount, teams) => {
  const isDoubles = (tournamentType || "").toLowerCase().includes("doubles");
  const has3Players = (teams || []).some((t) => t.playerPositions?.C);
  const prefix = has3Players ? (isDoubles ? "doubles_3p" : "singles_3p") : (isDoubles ? "doubles" : "singles");
  if (setCount >= 7) return `${prefix}_bo7`;
  if (setCount >= 5) return `${prefix}_bo5`;
  return `${prefix}_bo3`;
};

const generateMatchSequence = (format) => {
  const sequences = {
    "Singles - 3 Sets": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Singles A-Y", homePos: "A", awayPos: "B" }, // Replaced C-Z with A-Y
    ],
    "Singles - 5 Sets": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Singles A-Y", homePos: "A", awayPos: "B" }, // Replaced C-Z with A-Y
      { setNumber: 4, type: "Singles B-X", homePos: "B", awayPos: "A" },
      { setNumber: 5, type: "Singles A-X", homePos: "A", awayPos: "A" }, // Tie-breaker
    ],
    "Doubles - 3 Sets": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      {
        setNumber: 2,
        type: "Doubles AB-XY",
        homePos: "A",
        awayPos: "A",
        homePosB: "B",
        awayPosZ: "B",
      },
      { setNumber: 3, type: "Singles B-Y", homePos: "B", awayPos: "B" },
    ],
    "Doubles - 5 Sets": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      {
        setNumber: 3,
        type: "Doubles AB-XY",
        homePos: "A",
        awayPos: "A",
        homePosB: "B",
        awayPosZ: "B",
      },
      { setNumber: 4, type: "Singles A-Y", homePos: "A", awayPos: "B" },
      { setNumber: 5, type: "Singles B-X", homePos: "B", awayPos: "A" },
    ],
    // KEPT AS ALIASES FOR COMPATIBILITY
    "Singles - 3 Sets (2 Players)": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Singles A-Y", homePos: "A", awayPos: "B" },
    ],
    "Singles - 5 Sets (2 Players)": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Singles A-Y", homePos: "A", awayPos: "B" },
      { setNumber: 4, type: "Singles B-X", homePos: "B", awayPos: "A" },
      { setNumber: 5, type: "Singles A-X", homePos: "A", awayPos: "A" },
    ],
    "Doubles - 3 Sets (2 Players)": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Doubles AB-XY", homePos: "A", awayPos: "A", homePosB: "B", awayPosZ: "B" },
      { setNumber: 3, type: "Singles B-Y", homePos: "B", awayPos: "B" },
    ],
    "Doubles - 5 Sets (2 Players)": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Doubles AB-XY", homePos: "A", awayPos: "A", homePosB: "B", awayPosZ: "B" },
      { setNumber: 4, type: "Singles A-Y", homePos: "A", awayPos: "B" },
      { setNumber: 5, type: "Singles B-X", homePos: "B", awayPos: "A" },
    ],
    // BO7 formats
    "Singles - 7 Sets": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Singles A-Y", homePos: "A", awayPos: "B" },
      { setNumber: 4, type: "Singles B-X", homePos: "B", awayPos: "A" },
      { setNumber: 5, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 6, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 7, type: "Singles A-Y", homePos: "A", awayPos: "B" },
    ],
    "Doubles - 7 Sets": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Doubles AB-XY", homePos: "A", awayPos: "A", homePosB: "B", awayPosZ: "B" },
      { setNumber: 4, type: "Singles A-Y", homePos: "A", awayPos: "B" },
      { setNumber: 5, type: "Singles B-X", homePos: "B", awayPos: "A" },
      { setNumber: 6, type: "Doubles AB-XY", homePos: "A", awayPos: "A", homePosB: "B", awayPosZ: "B" },
      { setNumber: 7, type: "Singles A-X", homePos: "A", awayPos: "A" },
    ],
    "Singles - 7 Sets (2 Players)": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Singles A-Y", homePos: "A", awayPos: "B" },
      { setNumber: 4, type: "Singles B-X", homePos: "B", awayPos: "A" },
      { setNumber: 5, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 6, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 7, type: "Singles A-Y", homePos: "A", awayPos: "B" },
    ],
    "Doubles - 7 Sets (2 Players)": [
      { setNumber: 1, type: "Singles A-X", homePos: "A", awayPos: "A" },
      { setNumber: 2, type: "Singles B-Y", homePos: "B", awayPos: "B" },
      { setNumber: 3, type: "Doubles AB-XY", homePos: "A", awayPos: "A", homePosB: "B", awayPosZ: "B" },
      { setNumber: 4, type: "Singles A-Y", homePos: "A", awayPos: "B" },
      { setNumber: 5, type: "Singles B-X", homePos: "B", awayPos: "A" },
      { setNumber: 6, type: "Doubles AB-XY", homePos: "A", awayPos: "A", homePosB: "B", awayPosZ: "B" },
      { setNumber: 7, type: "Singles A-X", homePos: "A", awayPos: "A" },
    ],
  };

  const seq = sequences[format];
  if (!seq) {
    console.error(`[TEAM_KNOCKOUT] Unsupported format: "${format}". Available: ${Object.keys(sequences).join(", ")}`);
    throw new Error(`Unsupported team knockout format: "${format}"`);
  }
  return seq;
};

const extractPlayerName = (player) => {
  // If it's already a string
  if (typeof player === "string" && player.trim()) {
    return player.trim();
  }

  // If it's an object with a name property
  if (player && typeof player === "object" && player.name) {
    return typeof player.name === "string"
      ? player.name.trim()
      : extractPlayerName(player.name);
  }

  // If it's a character-by-character object (like in corrupted data)
  if (typeof player === "object" && player !== null && !Array.isArray(player)) {
    const chars = [];

    // Extract keys, filter for numeric keys, sort them in order
    Object.keys(player)
      .filter((key) => !isNaN(key))
      .sort((a, b) => Number(a) - Number(b))
      .forEach((key) => chars.push(player[key]));

    const result = chars.join("").trim();

    return result || "Unknown Player";
  }

  // If it's an array
  if (Array.isArray(player) && player.length > 0) {
    return extractPlayerName(player[0]);
  }

  // Fallback
  return "Unknown Player";
};

// Returns roster slots A/B (with TBD placeholders) and C (null unless a third
// valid player exists AND the caller's format plays slot C).
const getValidPlayers = (sourceData, includeC = false) => {
  const invalidNames = [
    "Unknown Player",
    "TBD",
    "Captain TBD",
    "Player B TBD",
    "Player C TBD",
    "Player D TBD",
    "",
    null,
    undefined,
  ];
  const playersFound = new Array(); // Use array to preserve order
  const playerSet = new Set();

  const addIfValid = (name) => {
    const cleaned = extractPlayerName(name);
    if (cleaned && !invalidNames.includes(cleaned) && !playerSet.has(cleaned)) {
      playerSet.add(cleaned);
      playersFound.push(cleaned);
    }
  };

  // 1. Check positions B, C, D ONLY (Ignore A/Captain slot)
  if (sourceData.positions) {
    ["B", "C", "D"].forEach((p) => addIfValid(sourceData.positions[p]));
  }

  // 2. DO NOT check sourceData.captain (Explicitly requested to remove it)

  // 3. Check players array
  if (Array.isArray(sourceData.players)) {
    sourceData.players.forEach((p) => addIfValid(p));
  }

  return {
    A: playersFound[0] || "Player 1 TBD",
    B: playersFound[1] || "Player 2 TBD",
    C: includeC ? playersFound[2] || null : null,
  };
};

// NEW: Improved substitute extraction function
const extractSubstitutes = (substitutesData) => {

  if (!substitutesData) {
    return [];
  }

  if (!Array.isArray(substitutesData)) {
    console.warn("Substitutes data is not an array:", substitutesData);
    return [];
  }

  const extractedSubstitutes = [];

  substitutesData.forEach((substitute, index) => {

    // Extract character values by iterating through numeric keys
    const chars = [];
    let i = 0;

    // Keep extracting while numeric keys exist
    while (substitute[i.toString()] !== undefined) {
      chars.push(substitute[i.toString()]);
      i++;
    }

    // Join characters and clean up
    const substituteName = chars.join("").trim();

    if (substituteName && substituteName !== "") {
      extractedSubstitutes.push(substituteName);
    } else {
      console.warn(`⚠️ Empty substitute name for index ${index + 1}`);
      extractedSubstitutes.push(`Substitute ${index + 1}`);
    }
  });

  return extractedSubstitutes;
};

const getSetsRequiredToWin = (formatOrId, match) => {
  // Method 1: Config-driven lookup by formatId
  try {
    const fmt = getFormat(formatOrId);
    if (fmt?.setsToWin) return fmt.setsToWin;
  } catch {}

  // Method 2: Numeric computation from match's frozen matchFormat
  if (match?.matchFormat?.setsToWin) return match.matchFormat.setsToWin;
  if (match?.matchFormat?.totalSets) return Math.ceil(match.matchFormat.totalSets / 2);

  // Method 3: Extract number from format string → compute
  if (typeof formatOrId === "string") {
    const numMatch = formatOrId.match(/(\d+)\s*Sets/);
    if (numMatch) return Math.ceil(parseInt(numMatch[1]) / 2);
  }

  // Fallback: compute from format string or use 1 as sport-neutral minimum
  return 1;
};

const getGamesRequiredToWin = (match) => {
  // Read from gameRules (frozen at match creation) — no hardcoded sport defaults
  return match?.gameRules?.gamesToWin || 1;
};

// Build a tie's sets from the config formula (A/B/C vs X/Y/Z). Every round
// and round robin go through here so the manager's chosen formula is honoured.
const buildSetsFromFormat = (formatConfig, team1, team2) =>
  isRapidRalliesFormat(formatConfig)
    ? buildRapidRalliesSets(slotMapFromTeam(team1), slotMapFromTeam(team2))
    : formatConfig.sets.map((setDef) => resolveSetPlayers(setDef, team1, team2));

// Names of teams that cannot play a 3-player formula (no player in slot C).
const teamsMissingSlotC = (formatId, teams) =>
  needsThirdPlayer(formatId)
    ? teams.filter((t) => !t.playerPositions?.C).map((t) => t.teamName)
    : [];

const teamKnockoutController = {
  // ================================
  // TOURNAMENT CREATION  
  // ================================

  createTournamentFromBookings: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        tournamentId,
        selectedBookingIds,
        byeBookingIds = [],
        scheduleDetails,
        tournamentType,
        setCount,
        cleanedTeamData, // NEW: Get cleaned data from frontend
        sportId: sportIdRaw, // multi-sport: which sport-track this team-KO is for
      } = req.body;

      if (!tournamentId || !selectedBookingIds || !scheduleDetails) {
        return res.status(400).json({
          success: false,
          message: "Required fields missing",
        });
      }

      // Load tournament + resolve the sport track. Multi-sport tournaments must
      // read THIS sport's format, not sports[0]. resolveSportId falls back to
      // sports[0] for single-sport / legacy tournaments.
      const tournament = await Tournament.findById(tournamentId).lean();
      const { getMatchFormat: _gmf, getDavisCupFormatId: _gdcf, resolveSportId: _rsid } = require("../utils/sportTrackUtils");
      const sportId = _rsid(tournament, sportIdRaw);
      const tf = _gmf(tournament, sportId) || {};
      const gameRulesFromTournament = {
        gamesPerSet: tf.totalGames || null,
        gamesToWin: tf.gamesToWin || null,
        pointsToWinGame: tf.pointsToWinGame || null,
        marginToWin: tf.marginToWin ?? null,
        deuceRule: tf.deuceRule !== undefined ? tf.deuceRule : false,
        maxPointsCap: tf.maxPointsCap || null,
      };

      // 3-player formulas (ABC vs XYZ) need roster slot C filled.
      const includeC = needsThirdPlayer(_gdcf(tournament, sportId));

      // Use cleaned data if available, otherwise fall back to database fetch
      let teamRecords;

      if (cleanedTeamData && cleanedTeamData.length > 0) {
        // Create team records from cleaned frontend data
        teamRecords = cleanedTeamData.map((teamData, index) => {
          const validPlayers = getValidPlayers(teamData.team, includeC);

          return {
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            originalBookingId: teamData._id,
            teamName: teamData.team.name.trim(),
            playerPositions: {
              A: validPlayers.A,
              B: validPlayers.B,
              C: validPlayers.C,
            },
            substitutes: teamData.team.substitutes || [],
            seeding: index + 1,
            byeAssigned: byeBookingIds.includes(teamData._id.toString()),
            status: byeBookingIds.includes(teamData._id.toString())
              ? "BYE_ASSIGNED"
              : "ACTIVE",
          };
        });
      } else {
        console.log("No cleaned data provided, falling back to database fetch");

        // Fetch selected bookings (existing logic)
        const selectedBookings = await Booking.find({
          _id: { $in: selectedBookingIds },
          tournamentId,
        }).session(session);

        if (selectedBookings.length !== selectedBookingIds.length) {
          return res.status(400).json({
            success: false,
            message: "Some selected bookings not found",
          });
        }

        // Create team records from bookings
        teamRecords = selectedBookings.map((booking, index) => {
          const validPlayers = getValidPlayers(booking.team, includeC);
          const substitutes = extractSubstitutes(booking.team.substitutes);

          return {
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            originalBookingId: booking._id,
            teamName: booking.team.name.trim(),
            playerPositions: {
              A: validPlayers.A,
              B: validPlayers.B,
              C: validPlayers.C,
            },
            substitutes: substitutes,
            seeding: index + 1,
            byeAssigned: byeBookingIds.includes(booking._id.toString()),
            status: byeBookingIds.includes(booking._id.toString())
              ? "BYE_ASSIGNED"
              : "ACTIVE",
          };
        });
      }

      // Check for existing teams to prevent duplicates
      const existingTeams = await TeamKnockoutTeams.find({
        tournamentId,
        originalBookingId: { $in: teamRecords.map((tr) => tr.originalBookingId) },
      }).session(session);

      const existingTeamMap = new Map(
        existingTeams.map((t) => [t.originalBookingId.toString(), t])
      );

      const newTeamsToCreate = [];
      const finalTeams = [];

      for (const record of teamRecords) {
        const existing = existingTeamMap.get(
          record.originalBookingId.toString()
        );
        if (existing) {
          // Robust Repair logic
          const hasInvalidA = !existing.playerPositions.A || existing.playerPositions.A === "Unknown Player" || existing.playerPositions.A.includes("TBD");
          // Slot C must match the formula: filled for 3-player, empty for 2-player.
          const slotCMismatch = (existing.playerPositions.C || null) !== (record.playerPositions.C || null);

          if (hasInvalidA || slotCMismatch) {
            console.log(`Repairing player slots for ${existing.teamName}`);
            existing.playerPositions = {
              A: record.playerPositions.A,
              B: record.playerPositions.B,
              C: record.playerPositions.C,
            };
            existing.markModified("playerPositions");
            await existing.save({ session });
          }
          finalTeams.push(existing);
        } else {
          newTeamsToCreate.push(record);
        }
      }

      if (newTeamsToCreate.length > 0) {
        const insertedTeams = await TeamKnockoutTeams.insertMany(newTeamsToCreate, { session });
        finalTeams.push(...insertedTeams);
        console.log(`Created ${insertedTeams.length} new teams.`);
      }

      const createdTeams = finalTeams;
      console.log("Total teams ready:", createdTeams.length);

      const missingC = teamsMissingSlotC(_gdcf(tournament, sportId), createdTeams);
      if (missingC.length > 0) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: `This formula needs 3 players per team (A/B/C). Add a third player to: ${missingC.join(", ")}`,
        });
      }

      // Check if matches already exist
      const existingMatches = await TeamKnockoutMatches.find({
        tournamentId,
      }).populate("team1Id team2Id winnerId").session(session);

      const occupiedTeamIds = new Set();
      let maxBracketPosition = 0;

      existingMatches.forEach((m) => {
        if (m.round === 1) {
          if (m.team1Id) occupiedTeamIds.add(m.team1Id._id.toString());
          if (m.team2Id) occupiedTeamIds.add(m.team2Id._id.toString());
          if (m.bracketPosition > maxBracketPosition) {
            maxBracketPosition = m.bracketPosition;
          }
        }
      });

      // Filter out teams that are already in a match
      const teamsToProcess = createdTeams.filter(
        (t) => !occupiedTeamIds.has(t._id.toString())
      );

      console.log(
        `Found ${existingMatches.length} existing matches. Processing ${teamsToProcess.length} remaining teams.`
      );

      if (teamsToProcess.length === 0 && existingMatches.length > 0) {
        console.log("Matches already exist for all teams. Returning existing structure.");
        await session.commitTransaction();

        return res.status(200).json({
          success: true,
          message: "Tournament matches already loaded",
          teams: createdTeams,
          matches: existingMatches,
          totalRounds: Math.ceil(Math.log2(totalTeams)),
        });
      }

      // Calculate tournament structure
      const totalTeams = selectedBookingIds.length;
      const totalSlots = Math.pow(2, Math.ceil(Math.log2(totalTeams)));
      const byesNeeded = totalSlots - totalTeams;

      // Verify bye count matches calculation
      if (byeBookingIds.length !== byesNeeded) {
        return res.status(400).json({
          success: false,
          message: `Expected ${byesNeeded} byes, but got ${byeBookingIds.length}`,
        });
      }

      // Separate teams (Use teamsToProcess instead of createdTeams for generation)
      const nonByeTeams = teamsToProcess.filter((team) => !team.byeAssigned);
      const byeTeams = teamsToProcess.filter((team) => team.byeAssigned);

      // Shuffle non-bye teams for random matchups
      const shuffledTeams = [...nonByeTeams].sort(() => 0.5 - Math.random());

      // Normalize setCount to a supported value (3, 5, or 7)
      const rawSetCount = parseInt(setCount, 10) || 3;
      const validSetCount = rawSetCount >= 7 ? 7 : rawSetCount >= 5 ? 5 : 3;

      const matches = [];
      const format = `${tournamentType} - ${validSetCount} Sets`;
      const baseStartTime = new Date(scheduleDetails.matchStartTime);
      const intervalMinutes = parseInt(scheduleDetails.matchInterval) || 0;

      // Create matches between competing teams
      for (let i = 0; i < shuffledTeams.length; i += 2) {
        const team1 = shuffledTeams[i];
        const team2 = shuffledTeams[i + 1];

        const matchStartTime = new Date(
          baseStartTime.getTime() + Math.floor(i / 2) * intervalMinutes * 60000
        );

        if (team2) {
          // Regular match between two teams
          console.log(
            `Creating regular match: ${team1.teamName} vs ${team2.teamName}`
          );

          // Use config-driven format if davisCupFormatId is set, otherwise derive from legacy params.
          const formatId = _gdcf(tournament, sportId) || deriveFormatId(tournamentType, validSetCount, createdTeams);
          let formatConfig;
          try {
            formatConfig = getFormat(formatId);
          } catch {
            // Fallback to singles_bo3 if format not found
            formatConfig = getFormat("singles_bo3");
          }

          // Generate sets from config
          const matchSets = buildSetsFromFormat(formatConfig, team1, team2);

          matches.push({
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            round: 1,
            bracketPosition: maxBracketPosition + Math.floor(i / 2) + 1,
            team1Id: team1._id,
            team2Id: team2._id,
            formatId: formatId,
            format: formatConfig.name,
            gameRules: gameRulesFromTournament,
            matchDate: matchStartTime,
            courtNumber: scheduleDetails.courtNumber || "TBD",
            status: "SCHEDULED",
            isBye: false,
            sets: matchSets,
            liveState: {
              currentSetNumber: 1,
              currentGameNumber: 1,
              currentPoints: { home: 0, away: 0 },
              lastUpdated: new Date(),
            },
            setsWon: { home: 0, away: 0 },
            matchWinner: null,
          });
        } else {
          // Odd team gets a bye
          console.log(`Creating odd-team bye match for: ${team1.teamName}`);

          // BYE matches still need a valid formatId to satisfy schema validation.
          const byeFormatId = _gdcf(tournament, sportId) || deriveFormatId(tournamentType, validSetCount, createdTeams);
          let byeFormatName = `${tournamentType} - ${validSetCount} Sets`;
          try { byeFormatName = getFormat(byeFormatId).name; } catch {}

          matches.push({
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            round: 1,
            bracketPosition: maxBracketPosition + Math.floor(i / 2) + 1,
            team1Id: team1._id,
            team2Id: null,
            formatId: byeFormatId,
            format: byeFormatName,
            matchDate: matchStartTime,
            courtNumber: "BYE",
            status: "BYE",
            isBye: true,
            sets: [],
            setsWon: { home: 1, away: 0 },
            matchWinner: "home",
            winnerId: team1._id,
            completedAt: new Date(),
          });
        }
      }

      // Create bye matches for pre-assigned bye teams.
      const preAssignedByeFormatId = _gdcf(tournament, sportId) || deriveFormatId(tournamentType, validSetCount, createdTeams);
      let preAssignedByeFormatName = `${tournamentType} - ${validSetCount} Sets`;
      try { preAssignedByeFormatName = getFormat(preAssignedByeFormatId).name; } catch {}

      byeTeams.forEach((team, index) => {
        console.log(`Creating pre-assigned bye match for: ${team.teamName}`);

        matches.push({
          tournamentId: new mongoose.Types.ObjectId(tournamentId),
          round: 1,
          bracketPosition: maxBracketPosition + Math.floor(shuffledTeams.length / 2) + index + 1,
          team1Id: team._id,
          team2Id: null,
          formatId: preAssignedByeFormatId,
          format: preAssignedByeFormatName,
          matchDate: baseStartTime,
          courtNumber: "BYE",
          status: "BYE",
          isBye: true,
          sets: [],
          setsWon: { home: 1, away: 0 },
          matchWinner: "home",
          winnerId: team._id,
          completedAt: new Date(),
        });
      });

      console.log(`Creating ${matches.length} matches total`);

      // Validate matches before creation
      matches.forEach((match, index) => {
        if (!match.isBye && match.sets) {
          match.sets.forEach((set, setIndex) => {
            // Log warning instead of throwing error if player is missing
            if (!set.awayPlayer && !set.homePlayer) {
              console.warn(
                `Match ${index + 1}, Set ${setIndex + 1} has missing players:`,
                set
              );
            }
          });
        }
      });

      // Stamp the resolved sportId on every match so multi-sport reads/queries
      // can scope by sport-track (and the format resolved above is consistent).
      for (const m of matches) { if (sportId && !m.sportId) m.sportId = sportId; }

      const createdMatches = await TeamKnockoutMatches.insertMany(matches, {
        session,
      });

      await session.commitTransaction();

      // Return populated matches
      const populatedMatches = await TeamKnockoutMatches.find({
        _id: { $in: createdMatches.map((m) => m._id) },
      }).populate("team1Id team2Id winnerId");

      console.log(
        "Tournament created successfully with",
        populatedMatches.length,
        "matches"
      );

      return res.status(201).json({
        success: true,
        message: "Tournament created successfully",
        teams: createdTeams,
        matches: populatedMatches,
        totalRounds: Math.ceil(Math.log2(totalTeams)),
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error creating tournament:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    } finally {
      session.endSession();
    }
  },

  // ================================
  // ROUND ROBIN MATCH GENERATION
  // ================================

  generateRoundRobinMatches: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        tournamentId,
        scheduleDetails,
        tournamentType = "Singles",
        setCount = 3,
      } = req.body;

      if (!tournamentId || !scheduleDetails) {
        return res.status(400).json({
          success: false,
          message: "tournamentId and scheduleDetails are required",
        });
      }

      // Load tournament for game rules — resolve the sport-track for multi-sport.
      const tournament = await Tournament.findById(tournamentId).lean();
      const { getMatchFormat: _gmf2, getDavisCupFormatId: _gdcf4, resolveSportId: _rsid2 } = require("../utils/sportTrackUtils");
      const sportId = _rsid2(tournament, req.body.sportId);

      // 3-player formulas (ABC vs XYZ) need roster slot C filled.
      const includeC = needsThirdPlayer(_gdcf4(tournament, sportId));

      // Get all active teams for this tournament
      let teams = await TeamKnockoutTeams.find({
        tournamentId,
        status: { $in: ["ACTIVE", "BYE_ASSIGNED"] },
      }).session(session);

      // If no TeamKnockoutTeams exist (round robin is being run before any knockout),
      // bootstrap them from the tournament's bookings so the user can use round robin
      // standalone without first creating a knockout bracket.
      if (teams.length < 2) {
        const bookings = await Booking.find({ tournamentId }).session(session);

        if (bookings.length < 2) {
          return res.status(400).json({
            success: false,
            message: "Need at least 2 registered teams to generate round robin matches",
          });
        }

        const bootstrapRecords = bookings.map((booking, index) => {
          const validPlayers = getValidPlayers(booking.team || {}, includeC);
          const substitutes = extractSubstitutes(booking.team?.substitutes);
          return {
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            originalBookingId: booking._id,
            teamName: (booking.team?.name || `Team ${index + 1}`).trim(),
            playerPositions: {
              A: validPlayers.A,
              B: validPlayers.B,
              C: validPlayers.C,
            },
            substitutes,
            seeding: index + 1,
            byeAssigned: false,
            status: "ACTIVE",
          };
        });

        const inserted = await TeamKnockoutTeams.insertMany(bootstrapRecords, { session });
        teams = inserted;
      }

      // Check if round robin matches already exist (round = 0 means round robin)
      const existingRR = await TeamKnockoutMatches.countDocuments({
        tournamentId,
        round: 0,
      }).session(session);

      if (existingRR > 0) {
        return res.status(400).json({
          success: false,
          message: "Round robin matches already generated. Delete them first to regenerate.",
        });
      }

      const tf = _gmf2(tournament, sportId) || {};
      const gameRulesFromTournament = {
        gamesPerSet: tf.totalGames || null,
        gamesToWin: tf.gamesToWin || null,
        pointsToWinGame: tf.pointsToWinGame || null,
        marginToWin: tf.marginToWin ?? null,
        deuceRule: tf.deuceRule !== undefined ? tf.deuceRule : false,
        maxPointsCap: tf.maxPointsCap || null,
      };

      // Court pool — ties are round-robin distributed across these so each
      // court/table hosts a share of the league (and its assigned umpire covers
      // them). Priority: manager-selected subset → tournament's active courts →
      // legacy single court → "TBD".
      const courtPool = (() => {
        const selected = Array.isArray(scheduleDetails.courtNames)
          ? scheduleDetails.courtNames.map((c) => String(c).trim()).filter(Boolean)
          : [];
        if (selected.length) return selected;
        const active = (tournament.courts || [])
          .filter((c) => c && c.isActive !== false && c.name)
          .map((c) => String(c.name).trim())
          .filter(Boolean);
        if (active.length) return active;
        const single = scheduleDetails.courtNumber ? String(scheduleDetails.courtNumber).trim() : "";
        return single ? [single] : ["TBD"];
      })();

      // Determine format
      const useTwoPlayerFormat = teams.every(
        (t) => !t.playerPositions.C || t.playerPositions.C === null
      );

      // Normalize setCount to a supported value (only 3, 5, 7 are supported by the
      // match-sequence registry). Anything below 3 maps to 3, between 3-5 maps to 5,
      // 7+ maps to 7. This protects round robin from tournaments stored with legacy
      // setFormat values like "1 set" or "2 sets".
      const rawSetCount = parseInt(setCount, 10) || 3;
      const validSetCount = rawSetCount >= 7 ? 7 : rawSetCount >= 5 ? 5 : 3;

      let effectiveFormat = `${tournamentType} - ${validSetCount} Sets`;
      if (useTwoPlayerFormat) effectiveFormat += " (2 Players)";

      // Resolve formatId (required by schema). Prefer per-sport davisCupFormatId, else derive.
      const rrFormatId = _gdcf4(tournament, sportId) || deriveFormatId(tournamentType, validSetCount, teams);
      let rrFormatName = effectiveFormat;
      let rrFormatConfig = null;
      try { rrFormatConfig = getFormat(rrFormatId); rrFormatName = rrFormatConfig.name; } catch {}

      // Rapid Rallies (5-slot dynamic tie) uses the config registry + roster
      // slots P1..P5, NOT the legacy A/B/C generateMatchSequence path.
      const rapidRallies = isRapidRalliesFormat(rrFormatConfig);
      if (rapidRallies) {
        for (const t of teams) {
          const rosterCheck = RRLineup.validateRoster(genderMapFromTeam(t));
          if (!rosterCheck.valid) {
            await session.abortTransaction();
            return res.status(400).json({
              success: false,
              message: `Team "${t.teamName}" is not ready for Rapid Rallies: ${rosterCheck.errors.join(" ")}`,
            });
          }
        }
      }

      const missingC = teamsMissingSlotC(rrFormatId, teams);
      if (missingC.length > 0) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: `This formula needs 3 players per team (A/B/C). Add a third player to: ${missingC.join(", ")}`,
        });
      }

      // Generate all possible matchups (round robin: every team plays every other team)
      const matches = [];
      const baseStartTime = new Date(scheduleDetails.matchStartTime);
      const intervalMinutes = parseInt(scheduleDetails.matchInterval) || 30;
      let matchIndex = 0;

      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const team1 = teams[i];
          const team2 = teams[j];

          const matchStartTime = new Date(
            baseStartTime.getTime() + matchIndex * intervalMinutes * 60000
          );

          // Generate sets with proper player assignments
          let matchSets;
          if (rapidRallies) {
            // 5-slot config-registry path — dynamic picks default to placeholders
            // and are locked live via selectRapidRalliesPick.
            matchSets = buildRapidRalliesSets(
              slotMapFromTeam(team1),
              slotMapFromTeam(team2)
            );
          } else if (rrFormatConfig) {
            // Manager's chosen formula (same as knockout rounds).
            matchSets = buildSetsFromFormat(rrFormatConfig, team1, team2);
          } else {
            matchSets = generateMatchSequence(effectiveFormat).map((seq) => ({
              setNumber: seq.setNumber,
              type: seq.type,
              homePlayer: team1.playerPositions[seq.homePos] || null,
              awayPlayer: team2.playerPositions[seq.awayPos] || null,
              homePlayerB: seq.homePosB
                ? team1.playerPositions[seq.homePosB] || null
                : null,
              awayPlayerB: seq.awayPosZ
                ? team2.playerPositions[seq.awayPosZ] || null
                : null,
              status: "PENDING",
              games: [],
              gamesWon: { home: 0, away: 0 },
              setWinner: null,
            }));
          }

          matches.push({
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            round: 0, // 0 = round robin (not knockout)
            bracketPosition: matchIndex + 1,
            team1Id: team1._id,
            team2Id: team2._id,
            formatId: rrFormatId,
            format: rrFormatName,
            gameRules: gameRulesFromTournament,
            matchDate: matchStartTime,
            courtNumber: courtPool[matchIndex % courtPool.length],
            status: "SCHEDULED",
            isBye: false,
            sets: matchSets,
            ...(rapidRallies ? { rrSelections: { home: {}, away: {} } } : {}),
            liveState: {
              currentSetNumber: 1,
              currentGameNumber: 1,
              currentPoints: { home: 0, away: 0 },
              lastUpdated: new Date(),
            },
            setsWon: { home: 0, away: 0 },
            matchWinner: null,
          });

          matchIndex++;
        }
      }

      for (const m of matches) { if (sportId && !m.sportId) m.sportId = sportId; }

      // Insert all round robin matches
      const createdMatches = await TeamKnockoutMatches.insertMany(matches, {
        session,
      });

      await session.commitTransaction();

      const totalMatches = teams.length * (teams.length - 1) / 2;

      res.status(201).json({
        success: true,
        message: `Round robin matches generated: ${totalMatches} matches for ${teams.length} teams`,
        data: {
          totalTeams: teams.length,
          totalMatches,
          matches: createdMatches,
        },
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("[ROUND_ROBIN] Error:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    } finally {
      session.endSession();
    }
  },

  // Get round robin standings (points table)
  getRoundRobinStandings: async (req, res) => {
    try {
      const { tournamentId } = req.params;

      // Get all round robin matches (round = 0)
      const matches = await TeamKnockoutMatches.find({
        tournamentId,
        round: 0,
        isBye: false,
      })
        .populate("team1Id team2Id winnerId")
        .lean();

      // Get all teams
      const teams = await TeamKnockoutTeams.find({ tournamentId }).lean();

      // Build standings — sport-neutral using readMatchResult
      const standings = {};
      teams.forEach((team) => {
        standings[team._id.toString()] = {
          teamId: team._id,
          teamName: team.teamName,
          playerPositions: team.playerPositions,
          played: 0,
          won: 0,
          lost: 0,
          roundsWon: 0,
          roundsLost: 0,
          scoreFor: 0,
          scoreAgainst: 0,
          // Legacy aliases for backward compatibility
          setsWon: 0,
          setsLost: 0,
          gamesWon: 0,
          gamesLost: 0,
          points: 0,
        };
      });

      // Calculate from matches using sport-neutral abstraction
      matches.forEach((match) => {
        if (match.status !== "COMPLETED") return;

        const t1Id = (match.team1Id?._id || match.team1Id).toString();
        const t2Id = (match.team2Id?._id || match.team2Id).toString();

        if (!standings[t1Id] || !standings[t2Id]) return;

        // Both teams played
        standings[t1Id].played++;
        standings[t2Id].played++;

        // Use readMatchResult for sport-neutral score extraction
        try {
          const result = readMatchResult(match);
          const homeScore = result.player1Score || 0;
          const awayScore = result.player2Score || 0;

          standings[t1Id].roundsWon += homeScore;
          standings[t1Id].roundsLost += awayScore;
          standings[t2Id].roundsWon += awayScore;
          standings[t2Id].roundsLost += homeScore;

          // Legacy aliases
          standings[t1Id].setsWon += homeScore;
          standings[t1Id].setsLost += awayScore;
          standings[t2Id].setsWon += awayScore;
          standings[t2Id].setsLost += homeScore;
        } catch (e) {
          // Fallback: use raw setsWon if readMatchResult fails (legacy data)
          standings[t1Id].setsWon += match.setsWon?.home || 0;
          standings[t1Id].setsLost += match.setsWon?.away || 0;
          standings[t2Id].setsWon += match.setsWon?.away || 0;
          standings[t2Id].setsLost += match.setsWon?.home || 0;
          standings[t1Id].roundsWon += match.setsWon?.home || 0;
          standings[t1Id].roundsLost += match.setsWon?.away || 0;
          standings[t2Id].roundsWon += match.setsWon?.away || 0;
          standings[t2Id].roundsLost += match.setsWon?.home || 0;
        }

        // Games from sets (sub-round detail — keep for backward compat)
        (match.sets || []).forEach((set) => {
          standings[t1Id].gamesWon += set.gamesWon?.home || 0;
          standings[t1Id].gamesLost += set.gamesWon?.away || 0;
          standings[t2Id].gamesWon += set.gamesWon?.away || 0;
          standings[t2Id].gamesLost += set.gamesWon?.home || 0;
          // Also accumulate into scoreFor/Against
          standings[t1Id].scoreFor += set.gamesWon?.home || 0;
          standings[t1Id].scoreAgainst += set.gamesWon?.away || 0;
          standings[t2Id].scoreFor += set.gamesWon?.away || 0;
          standings[t2Id].scoreAgainst += set.gamesWon?.home || 0;
        });

        // Winner
        if (match.matchWinner === "home") {
          standings[t1Id].won++;
          standings[t1Id].points += 2;
          standings[t2Id].lost++;
        } else if (match.matchWinner === "away") {
          standings[t2Id].won++;
          standings[t2Id].points += 2;
          standings[t1Id].lost++;
        }
      });

      // Sort: tie points → total matches (rubbers) won → round diff → score diff.
      // Client ranking rule: tie points (win=2/loss=0), then total matches won.
      const sorted = Object.values(standings).sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon; // total matches won
        const aDiff = a.roundsWon - a.roundsLost;
        const bDiff = b.roundsWon - b.roundsLost;
        if (bDiff !== aDiff) return bDiff - aDiff;
        return (b.scoreFor - b.scoreAgainst) - (a.scoreFor - a.scoreAgainst);
      });

      const totalMatches = matches.length;
      const completedMatches = matches.filter((m) => m.status === "COMPLETED").length;

      res.json({
        success: true,
        data: {
          standings: sorted,
          totalMatches,
          completedMatches,
          allCompleted: completedMatches === totalMatches,
        },
      });
    } catch (error) {
      console.error("[RR_STANDINGS] Error:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },

  // Delete round robin matches (to regenerate)
  deleteRoundRobinMatches: async (req, res) => {
    try {
      const { tournamentId } = req.body;

      const result = await TeamKnockoutMatches.deleteMany({
        tournamentId,
        round: 0,
      });

      res.json({
        success: true,
        message: `Deleted ${result.deletedCount} round robin matches`,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },

  // ================================
  // LIVE SCORING
  // ================================

  getLiveMatchState: async (req, res) => {
    try {
      const { matchId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id winnerId"
      );

      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      return res.status(200).json({
        success: true,
        match,
        recoveryData: {
          currentSetNumber: match.liveState.currentSetNumber,
          currentGameNumber: match.liveState.currentGameNumber,
          currentPoints: match.liveState.currentPoints,
          lastUpdated: match.liveState.lastUpdated,
        },
      });
    } catch (error) {
      console.error("Error getting live match state:", error);
      return res.status(500).json({
        success: false,
        message: "Error getting live match state",
        error: error.message,
      });
    }
  },

  updateLiveScore: async (req, res) => {
    try {
      const { matchId } = req.params;
      const { homePoints, awayPoints } = req.body;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      if (homePoints === undefined || awayPoints === undefined) {
        return res.status(400).json({
          success: false,
          message: "Both home and away points required",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId);
      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      if (match.status !== "IN_PROGRESS" && match.status !== "SCHEDULED") {
        return res.status(400).json({
          success: false,
          message: "Match is not active for scoring",
        });
      }

      // Update live state
      match.liveState.currentPoints.home = homePoints;
      match.liveState.currentPoints.away = awayPoints;
      match.liveState.lastUpdated = new Date();

      // Start match if it's scheduled
      if (match.status === "SCHEDULED") {
        match.status = "IN_PROGRESS";

        // Start first set and first game
        if (match.sets.length > 0) {
          match.sets[0].status = "IN_PROGRESS";
          if (match.sets[0].games.length === 0) {
            match.sets[0].games.push({
              gameNumber: 1,
              homePoints: homePoints,
              awayPoints: awayPoints,
              winner: null,
              status: "IN_PROGRESS",
              startTime: new Date(),
              endTime: null,
            });
          }
        }
      } else {
        // Update current game points
        const currentSet = match.sets[match.liveState.currentSetNumber - 1];
        if (currentSet && currentSet.games.length > 0) {
          const currentGame =
            currentSet.games[match.liveState.currentGameNumber - 1];
          if (currentGame && currentGame.status === "IN_PROGRESS") {
            currentGame.homePoints = homePoints;
            currentGame.awayPoints = awayPoints;
          }
        }
      }

      await match.save({ validateModifiedOnly: true });

      const updatedMatch = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id"
      );

      return res.status(200).json({
        success: true,
        message: "Live score updated",
        match: updatedMatch,
      });
    } catch (error) {
      console.error("Error updating live score:", error);
      return res.status(500).json({
        success: false,
        message: "Error updating live score",
        error: error.message,
      });
    }
  },

  completeGame: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { matchId } = req.params;
      const { setNumber, gameNumber, finalHomePoints, finalAwayPoints } =
        req.body;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId).session(
        session
      );
      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      // Guard: never re-score a finished match. Without this, a double-tap /
      // client retry re-enters the completion block and double-counts the
      // winner's matchesWon/setsWon and the loser's matchesLost (corrupts the
      // team standings). Mirrors the group-stage / direct-knockout guards.
      if (match.status === "COMPLETED" || match.status === "completed") {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: "Cannot score a completed match. This match has already finished.",
        });
      }

      const currentSet = match.sets[setNumber - 1];
      if (!currentSet) {
        return res.status(400).json({
          success: false,
          message: "Invalid set number",
        });
      }

      // Complete the current game
      let currentGame = currentSet.games.find(g => g.gameNumber === gameNumber);

      // Validation: Check for tied scores on completion
      if (finalHomePoints === finalAwayPoints) {
        return res.status(400).json({
          success: false,
          message: "Game cannot be completed with a tied score",
        });
      }

      if (!currentGame) {
        // Create the game if it doesn't exist
        currentGame = {
          gameNumber: gameNumber,
          homePoints: finalHomePoints,
          awayPoints: finalAwayPoints,
          winner: finalHomePoints > finalAwayPoints ? "home" : "away",
          status: "COMPLETED",
          startTime: new Date(),
          endTime: new Date(),
        };
        currentSet.games.push(currentGame);

        // Ensure games are sorted by gameNumber after insertion
        currentSet.games.sort((a, b) => a.gameNumber - b.gameNumber);

      } else {
        // Update existing game
        currentGame.homePoints = finalHomePoints;
        currentGame.awayPoints = finalAwayPoints;
        currentGame.winner =
          finalHomePoints > finalAwayPoints ? "home" : "away";
        currentGame.status = "COMPLETED";
        currentGame.endTime = new Date();
      }

      // Update set games won
      currentSet.gamesWon.home = currentSet.games.filter(
        (g) => g.winner === "home"
      ).length;
      currentSet.gamesWon.away = currentSet.games.filter(
        (g) => g.winner === "away"
      ).length;

      const gamesNeeded = getGamesRequiredToWin(match);

      // Check if set is completed
      if (
        currentSet.gamesWon.home >= gamesNeeded ||
        currentSet.gamesWon.away >= gamesNeeded
      ) {
        currentSet.setWinner =
          currentSet.gamesWon.home > currentSet.gamesWon.away ? "home" : "away";
        currentSet.status = "COMPLETED";

        // Update match sets won
        match.setsWon.home = match.sets.filter(
          (s) => s.setWinner === "home"
        ).length;
        match.setsWon.away = match.sets.filter(
          (s) => s.setWinner === "away"
        ).length;

        const setsNeeded = getSetsRequiredToWin(match.formatId || match.format, match);

        // playAllSets formats (Rapid Rallies) finish only when ALL rubbers are
        // played (no dead rubbers); everything else finishes the moment a team
        // reaches setsNeeded. decideTieOutcome() encodes both.
        let _fmt = null;
        try { _fmt = getFormat(match.formatId); } catch { /* legacy string format */ }
        const playAllSets = !!(_fmt && _fmt.playAllSets);
        const tie = decideTieOutcome({ sets: match.sets, setsToWin: setsNeeded, playAllSets });

        // Check if match is completed
        if (tie.complete && tie.winner) {
          match.matchWinner = tie.winner;
          match.winnerId =
            match.matchWinner === "home" ? match.team1Id : match.team2Id;
          match.status = "COMPLETED";
          match.completedAt = new Date();

          // League fixtures (round 0) must NOT eliminate the loser — they play
          // their remaining round-robin ties. Only knockout ties eliminate.
          const isLeagueTie = match.round === 0;

          const winnerTeamId =
            match.matchWinner === "home" ? match.team1Id : match.team2Id;
          const loserTeamId =
            match.matchWinner === "home" ? match.team2Id : match.team1Id;

          const winnerTeam = await TeamKnockoutTeams.findById(
            winnerTeamId
          ).session(session);
          const loserTeam = await TeamKnockoutTeams.findById(
            loserTeamId
          ).session(session);

          if (winnerTeam) {
            winnerTeam.matchesWon += 1;
            winnerTeam.setsWon +=
              match.matchWinner === "home"
                ? match.setsWon.home
                : match.setsWon.away;
            winnerTeam.setsLost +=
              match.matchWinner === "home"
                ? match.setsWon.away
                : match.setsWon.home;
            await winnerTeam.save({ session });
          }

          if (loserTeam) {
            loserTeam.matchesLost += 1;
            if (!isLeagueTie) loserTeam.status = "ELIMINATED";
            loserTeam.setsWon +=
              match.matchWinner === "home"
                ? match.setsWon.away
                : match.setsWon.home;
            loserTeam.setsLost +=
              match.matchWinner === "home"
                ? match.setsWon.home
                : match.setsWon.away;
            await loserTeam.save({ session });
          }
        } else {
          // Move to next set
          const nextSetNumber = setNumber + 1;
          if (nextSetNumber <= match.sets.length) {
            match.liveState.currentSetNumber = nextSetNumber;
            match.liveState.currentGameNumber = 1;
            match.sets[nextSetNumber - 1].status = "IN_PROGRESS";
          }
        }
      } else {
        // Move to next game in same set
        const nextGameNumber = gameNumber + 1;
        match.liveState.currentGameNumber = nextGameNumber;

        // Create next game
        currentSet.games.push({
          gameNumber: nextGameNumber,
          homePoints: 0,
          awayPoints: 0,
          winner: null,
          status: "IN_PROGRESS",
          startTime: new Date(),
          endTime: null,
        });
      }

      // Reset live points for next game
      match.liveState.currentPoints = { home: 0, away: 0 };
      match.liveState.lastUpdated = new Date();

      await match.save({ session });
      await session.commitTransaction();

      const updatedMatch = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id winnerId"
      );

      return res.status(200).json({
        success: true,
        message: "Game completed successfully",
        match: updatedMatch,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error completing game:", error);
      return res.status(500).json({
        success: false,
        message: "Error completing game",
        error: error.message,
      });
    } finally {
      session.endSession();
    }
  },

  // ================================
  // MATCH QUERIES
  // ================================

  getMatchesByTournament: async (req, res) => {
    try {
      const { tournamentId } = req.params;

      if (!tournamentId) {
        return res.status(400).json({
          success: false,
          message: "Tournament ID is required",
        });
      }

      const matches = await TeamKnockoutMatches.find({ tournamentId })
        .populate("team1Id team2Id winnerId")
        .sort({ round: 1, bracketPosition: 1 });

      return res.status(200).json({
        success: true,
        matches,
      });
    } catch (error) {
      console.error("Error fetching matches:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching matches",
        error: error.message,
      });
    }
  },

  getMatchesByRound: async (req, res) => {
    try {
      const { tournamentId, round } = req.query;

      if (!tournamentId || !round) {
        return res.status(400).json({
          success: false,
          message: "Tournament ID and round are required",
        });
      }

      const matches = await TeamKnockoutMatches.find({
        tournamentId,
        round: parseInt(round),
      })
        .populate("team1Id team2Id winnerId")
        .sort({ bracketPosition: 1 });

      return res.status(200).json({
        success: true,
        matches,
      });
    } catch (error) {
      console.error("Error fetching round matches:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching round matches",
        error: error.message,
      });
    }
  },

  getMatchById: async (req, res) => {
    try {
      const { matchId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id"
      );

      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      return res.status(200).json({
        success: true,
        match,
      });
    } catch (error) {
      console.error("Error fetching match:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching match",
        error: error.message,
      });
    }
  },

  // ================================
  // NEXT ROUND GENERATION
  // ================================

  createNextRound: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        tournamentId,
        currentRound,
        scheduleDetails,
        playFormat,
        setCount,
      } = req.body;

      if (!tournamentId || !currentRound || !scheduleDetails) {
        return res.status(400).json({
          success: false,
          message: "Required fields missing",
        });
      }

      // Load tournament to get matchFormat for gameRules — resolve sport-track.
      const tournament = await Tournament.findById(tournamentId).lean();
      const { getMatchFormat: _gmf3, getDavisCupFormatId: _gdcf5, resolveSportId: _rsid3 } = require("../utils/sportTrackUtils");
      const sportId = _rsid3(tournament, req.body.sportId);
      const tf = _gmf3(tournament, sportId) || {};
      const gameRulesFromTournament = {
        gamesPerSet: tf.totalGames || null,
        gamesToWin: tf.gamesToWin || null,
        pointsToWinGame: tf.pointsToWinGame || null,
        marginToWin: tf.marginToWin ?? null,
        deuceRule: tf.deuceRule !== undefined ? tf.deuceRule : false,
        maxPointsCap: tf.maxPointsCap || null,
      }

      // Validate setCount properly (registry supports 3, 5, 7)
      const validatedSetCount = [3, 5, 7].includes(parseInt(setCount)) ? parseInt(setCount) : 3;

      // Determine match format components
      let finalPlayFormat = playFormat;

      // If playFormat is missing, try to infer it from the format string if provided
      if (!finalPlayFormat && req.body.format) {
        if (req.body.format.includes("Singles")) finalPlayFormat = "Singles";
        else if (req.body.format.includes("Doubles")) finalPlayFormat = "Doubles";
      }

      // Still nothing? Ask the tournament before falling back to a hardcoded
      // "Singles". A track configured as Doubles used to silently generate a
      // singles next round whenever the client omitted playFormat — the
      // configured format was never consulted at all.
      //
      // Resolved at SPORT level only: TeamKnockoutMatches carries no category
      // field, so there is no category in scope here. If per-category team
      // formats are ever needed, the match model needs a category first.
      if (!finalPlayFormat) {
        const { getKnockoutFormat: _gkf } = require("../utils/sportTrackUtils");
        const trackFormat = _gkf(tournament, sportId);
        if (trackFormat && /doubles/i.test(trackFormat)) finalPlayFormat = "Doubles";
        else if (trackFormat && /singles/i.test(trackFormat)) finalPlayFormat = "Singles";
      }

      // Default to Singles if still missing or invalid
      if (!finalPlayFormat || (finalPlayFormat !== "Singles" && finalPlayFormat !== "Single" && finalPlayFormat !== "Doubles" && finalPlayFormat !== "Double")) {
        finalPlayFormat = "Singles";
      }

      // Standardize the play format string
      const standardizedPlayFormat = (finalPlayFormat === "Single" || finalPlayFormat === "Singles") ? "Singles" : "Doubles";

      // Reconstruct the format string to ensure it's ALWAYS valid (matches enum: "Singles - 3 Sets", etc.)
      const format = `${standardizedPlayFormat} - ${validatedSetCount} Sets`;

      console.log(`Setting match format to: "${format}" (derived from playFormat: "${playFormat}", setCount: "${setCount}")`);

      // Get completed matches from previous round — ORDERED BY bracketPosition
      // so winners advance in bracket order (preserves seeding/structure).
      const previousRoundMatches = await TeamKnockoutMatches.find({
        tournamentId,
        round: currentRound - 1,
        status: { $in: ["COMPLETED", "BYE"] },
      }).sort({ bracketPosition: 1 }).session(session);

      if (previousRoundMatches.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No completed matches found in previous round",
        });
      }

      // Check if all previous round matches are completed
      const totalPreviousMatches = await TeamKnockoutMatches.countDocuments({
        tournamentId,
        round: currentRound - 1,
      });

      if (previousRoundMatches.length !== totalPreviousMatches) {
        return res.status(400).json({
          success: false,
          message: "Not all previous round matches are completed",
        });
      }

      // Resolve formatId — per-sport config first, then the formula the previous
      // round was played with, so every round uses the manager's chosen formula.
      const prevRoundFormatId = (previousRoundMatches.find((m) => !m.isBye) || previousRoundMatches[0])?.formatId;
      const nextRoundFormatId = _gdcf5(tournament, sportId) || tournament?.davisCupFormatId || prevRoundFormatId || deriveFormatId(standardizedPlayFormat, validatedSetCount, []);
      let nextRoundFormatName = format;
      let nextRoundFormatConfig = null;
      try {
        nextRoundFormatConfig = getFormat(nextRoundFormatId);
        nextRoundFormatName = nextRoundFormatConfig.name;
      } catch {}

      // Get winners
      const winners = previousRoundMatches.map((match) => ({
        teamId: match.winnerId,
        matchId: match._id,
      }));

      if (winners.length < 2) {
        return res.status(400).json({
          success: false,
          message: "Not enough winners for next round",
        });
      }

      // Preserve bracket order — winners already sorted by previous-round
      // bracketPosition above, so adjacent bracket winners meet (standard
      // single-elimination progression). NO random reshuffle: a random
      // re-pairing each round destroys seeding and bracket integrity.
      const shuffledWinners = winners;

      // Get winner team details
      const winnerTeams = await TeamKnockoutTeams.find({
        _id: { $in: shuffledWinners.map((w) => w.teamId) },
      }).session(session);

      const matches = [];
      const baseStartTime = new Date(scheduleDetails.matchStartTime);
      const intervalMinutes = parseInt(scheduleDetails.matchInterval) || 0;

      for (let i = 0; i < shuffledWinners.length; i += 2) {
        const winner1 = shuffledWinners[i];
        const winner2 = shuffledWinners[i + 1];

        const team1 = winnerTeams.find(
          (t) => t._id.toString() === winner1.teamId.toString()
        );
        const team2 = winner2
          ? winnerTeams.find(
            (t) => t._id.toString() === winner2.teamId.toString()
          )
          : null;

        const matchStartTime = new Date(
          baseStartTime.getTime() + Math.floor(i / 2) * intervalMinutes * 60000
        );

        if (team2) {
          const matchSets = nextRoundFormatConfig
            ? buildSetsFromFormat(nextRoundFormatConfig, team1, team2)
            : generateMatchSequence(format).map((seq) => ({
              setNumber: seq.setNumber,
              type: seq.type,
              homePlayer: team1.playerPositions[seq.homePos],
              awayPlayer: team2.playerPositions[seq.awayPos],
              homePlayerB: seq.homePosB
                ? team1.playerPositions[seq.homePosB]
                : null,
              awayPlayerB: seq.awayPosZ
                ? team2.playerPositions[seq.awayPosZ]
                : null,
              status: "PENDING",
              games: [],
              gamesWon: { home: 0, away: 0 },
              setWinner: null,
            }));

          matches.push({
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            round: currentRound,
            bracketPosition: Math.floor(i / 2) + 1,
            team1Id: team1._id,
            team2Id: team2._id,
            formatId: nextRoundFormatId,
            format: nextRoundFormatName,
            gameRules: gameRulesFromTournament,
            matchDate: matchStartTime,
            courtNumber: scheduleDetails.courtNumber || "TBD",
            status: "SCHEDULED",
            isBye: false,
            sets: matchSets,
            liveState: {
              currentSetNumber: 1,
              currentGameNumber: 1,
              currentPoints: { home: 0, away: 0 },
              lastUpdated: new Date(),
            },
            setsWon: { home: 0, away: 0 },
            matchWinner: null,
            winnerId: null,
          });
        } else {
          // Bye match
          matches.push({
            tournamentId: new mongoose.Types.ObjectId(tournamentId),
            round: currentRound,
            bracketPosition: Math.floor(i / 2) + 1,
            team1Id: team1._id,
            team2Id: null,
            formatId: nextRoundFormatId,
            format: nextRoundFormatName,
            matchDate: matchStartTime,
            courtNumber: "BYE",
            status: "BYE",
            isBye: true,
            sets: [],
            setsWon: { home: 1, away: 0 },
            matchWinner: "home",
            winnerId: team1._id,
            completedAt: new Date(),
          });
        }
      }

      // Advance teams to next round
      await TeamKnockoutTeams.updateMany(
        { _id: { $in: winners.map((w) => w.teamId) } },
        {
          $inc: { currentRound: 1 },
          $set: { status: "ACTIVE", byeAssigned: false },
        },
        { session }
      );

      for (const m of matches) { if (sportId && !m.sportId) m.sportId = sportId; }

      const createdMatches = await TeamKnockoutMatches.insertMany(matches, {
        session,
      });

      await session.commitTransaction();

      const populatedMatches = await TeamKnockoutMatches.find({
        _id: { $in: createdMatches.map((m) => m._id) },
      }).populate("team1Id team2Id winnerId");

      return res.status(201).json({
        success: true,
        message: `Round ${currentRound} matches created successfully`,
        matches: populatedMatches,
        round: currentRound,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error creating next round:", error);
      return res.status(500).json({
        success: false,
        message: "Error creating next round",
        error: error.message,
      });
    } finally {
      session.endSession();
    }
  },


  // ================================
  // TEAM MANAGEMENT
  // ================================

  getTeamsByTournament: async (req, res) => {
    try {
      const { tournamentId } = req.params;

      if (!tournamentId) {
        return res.status(400).json({
          success: false,
          message: "Tournament ID is required",
        });
      }

      const teams = await TeamKnockoutTeams.find({ tournamentId }).sort({
        seeding: 1,
      });

      return res.status(200).json({
        success: true,
        teams,
      });
    } catch (error) {
      console.error("Error fetching teams:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching teams",
        error: error.message,
      });
    }
  },

  // ================================
  // PLAYER SUBSTITUTIONS
  // ================================

  swapTeamPlayers: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { teamId } = req.params;

      if (!teamId) {
        return res.status(400).json({
          success: false,
          message: "Team ID is required",
        });
      }

      const team = await TeamKnockoutTeams.findById(teamId).session(session);
      if (!team) {
        return res.status(404).json({
          success: false,
          message: "Team not found",
        });
      }

      // Swap positions A and B
      const oldA = team.playerPositions.A;
      const oldB = team.playerPositions.B;

      team.playerPositions.A = oldB;
      team.playerPositions.B = oldA;

      await team.save({ session });

      // Update all SCHEDULED matches to reflect the swap
      const affectedMatches = await TeamKnockoutMatches.find({
        $or: [{ team1Id: teamId }, { team2Id: teamId }],
        status: "SCHEDULED",
      }).session(session);

      console.log(`Updating ${affectedMatches.length} matches due to player swap`);

      for (const match of affectedMatches) {
        let formatConfig = null;
        try { formatConfig = getFormat(match.formatId); } catch {}
        // Rapid Rallies ties use P1..P5 roster slots, not A/B — nothing to remap.
        if (isRapidRalliesFormat(formatConfig)) continue;

        const isTeam1 = match.team1Id.toString() === teamId;

        // Slot positions per set: config formula first, legacy sequence as fallback.
        const positionsFor = (set) => {
          if (formatConfig) {
            const setDef = formatConfig.sets.find((s) => s.setNumber === set.setNumber);
            return setDef ? resolveSetPositions(setDef, set.selectionId) : null;
          }
          let sequence;
          try { sequence = generateMatchSequence(match.format); } catch { return null; }
          const seq = sequence.find((s) => s.setNumber === set.setNumber);
          if (!seq) return null;
          return {
            homePos: [seq.homePos, seq.homePosB].filter(Boolean),
            awayPos: [seq.awayPos, seq.awayPosZ].filter(Boolean),
          };
        };

        match.sets.forEach((set) => {
          const pos = positionsFor(set);
          if (!pos) return;

          if (isTeam1) {
            // Update home players
            set.homePlayer = team.playerPositions[pos.homePos[0]] || null;
            if (pos.homePos[1]) {
              set.homePlayerB = team.playerPositions[pos.homePos[1]] || null;
            }
          } else {
            // Update away players
            set.awayPlayer = team.playerPositions[pos.awayPos[0]] || null;
            if (pos.awayPos[1]) {
              set.awayPlayerB = team.playerPositions[pos.awayPos[1]] || null;
            }
          }
        });

        match.markModified("sets");
        await match.save({ session });
      }

      await session.commitTransaction();

      return res.status(200).json({
        success: true,
        message: "Players swapped and matches updated successfully",
        team,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error swapping players:", error);
      return res.status(500).json({
        success: false,
        message: "Error swapping players",
        error: error.message,
      });
    } finally {
      session.endSession();
    }
  },

  substitutePlayer: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { teamId } = req.params;
      const { outgoingPlayer, incomingPlayer, position } = req.body;

      if (!teamId || !outgoingPlayer || !incomingPlayer || !position) {
        return res.status(400).json({
          success: false,
          message:
            "Team ID, outgoing player, incoming player, and position are required",
        });
      }

      if (!["A", "B", "C"].includes(position)) {
        return res.status(400).json({
          success: false,
          message: "Position must be A, B, or C",
        });
      }

      const team = await TeamKnockoutTeams.findById(teamId).session(session);
      if (!team) {
        return res.status(404).json({
          success: false,
          message: "Team not found",
        });
      }

      // Verify outgoing player exists in the specified position
      if (team.playerPositions[position] !== outgoingPlayer) {
        return res.status(400).json({
          success: false,
          message: `Player ${outgoingPlayer} is not in position ${position}`,
        });
      }

      // Update player position
      team.playerPositions[position] = incomingPlayer;

      // Add to substitutes list if not already there
      if (!team.substitutes.includes(incomingPlayer)) {
        team.substitutes.push(incomingPlayer);
      }

      await team.save({ session });
      await session.commitTransaction();

      return res.status(200).json({
        success: true,
        message: "Player substituted successfully",
        team,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error substituting player:", error);
      return res.status(500).json({
        success: false,
        message: "Error substituting player",
        error: error.message,
      });
    } finally {
      session.endSession();
    }
  },

  updateMatchLineup: async (req, res) => {
    try {
      const { matchId } = req.params;
      const { setNumber, homePlayerB } = req.body;
      // Older clients send the away partner as `awayPlayerZ`; the schema field is `awayPlayerB`.
      const awayPlayerB = req.body.awayPlayerB || req.body.awayPlayerZ;

      if (!matchId) {
        return res.status(400).json({
          success: false,
          message: "Match ID is required",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId);
      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      // Find the specific set (1-based index)
      const set = match.sets.find((s) => s.setNumber === setNumber);
      if (!set) {
        return res.status(404).json({
          success: false,
          message: `Set ${setNumber} not found`,
        });
      }

      // Update available fields
      if (homePlayerB) set.homePlayerB = homePlayerB;
      if (awayPlayerB) set.awayPlayerB = awayPlayerB;

      // Mark modified if using Mongoose mixed types or nested objects
      match.markModified('sets');

      await match.save({ validateModifiedOnly: true });

      return res.status(200).json({
        success: true,
        message: "Lineup updated successfully",
        match,
      });

    } catch (error) {
      console.error("Error updating lineup:", error);
      return res.status(500).json({
        success: false,
        message: "Error updating lineup",
        error: error.message,
      });
    }
  },

  // ================================
  // UTILITY METHODS
  // ================================

  startMatch: async (req, res) => {
    try {
      const { matchId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId);
      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      if (match.status !== "SCHEDULED") {
        return res.status(400).json({
          success: false,
          message: "Match cannot be started",
        });
      }

      match.status = "IN_PROGRESS";

      // Initialize first set and first game
      if (match.sets.length > 0) {
        match.sets[0].status = "IN_PROGRESS";
        match.sets[0].games.push({
          gameNumber: 1,
          homePoints: 0,
          awayPoints: 0,
          winner: null,
          status: "IN_PROGRESS",
          startTime: new Date(),
          endTime: null,
        });
      }

      await match.save({ validateModifiedOnly: true });

      const updatedMatch = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id"
      );

      return res.status(200).json({
        success: true,
        message: "Match started successfully",
        match: updatedMatch,
      });
    } catch (error) {
      console.error("Error starting match:", error);
      return res.status(500).json({
        success: false,
        message: "Error starting match",
        error: error.message,
      });
    }
  },

  rescheduleMatch: async (req, res) => {
    try {
      const { matchId } = req.params;
      const { newDate, newCourt } = req.body;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      if (!newDate) {
        return res.status(400).json({
          success: false,
          message: "New date is required",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId);
      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      if (match.status === "COMPLETED") {
        return res.status(400).json({
          success: false,
          message: "Cannot reschedule completed match",
        });
      }

      match.matchDate = new Date(newDate);
      if (newCourt) {
        match.courtNumber = newCourt;
      }

      await match.save({ validateModifiedOnly: true });

      const updatedMatch = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id"
      );

      return res.status(200).json({
        success: true,
        message: "Match rescheduled successfully",
        match: updatedMatch,
      });
    } catch (error) {
      console.error("Error rescheduling match:", error);
      return res.status(500).json({
        success: false,
        message: "Error rescheduling match",
        error: error.message,
      });
    }
  },

  cancelMatch: async (req, res) => {
    try {
      const { matchId } = req.params;
      const { reason } = req.body;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId);
      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      if (match.status === "COMPLETED") {
        return res.status(400).json({
          success: false,
          message: "Cannot cancel completed match",
        });
      }

      match.status = "CANCELLED";
      if (reason) {
        match.cancellationReason = reason;
      }

      await match.save({ validateModifiedOnly: true });

      const updatedMatch = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id"
      );

      return res.status(200).json({
        success: true,
        message: "Match cancelled successfully",
        match: updatedMatch,
      });
    } catch (error) {
      console.error("Error cancelling match:", error);
      return res.status(500).json({
        success: false,
        message: "Error cancelling match",
        error: error.message,
      });
    }
  },

  // ================================
  // TOURNAMENT STATISTICS
  // ================================

  getTournamentStatistics: async (req, res) => {
    try {
      const { tournamentId } = req.params;

      if (!tournamentId) {
        return res.status(400).json({
          success: false,
          message: "Tournament ID is required",
        });
      }

      // Get team statistics
      const totalTeams = await TeamKnockoutTeams.countDocuments({
        tournamentId,
      });
      const activeTeams = await TeamKnockoutTeams.countDocuments({
        tournamentId,
        status: { $in: ["ACTIVE", "BYE_ASSIGNED"] },
      });
      const eliminatedTeams = await TeamKnockoutTeams.countDocuments({
        tournamentId,
        status: "ELIMINATED",
      });

      // Get match statistics
      const totalMatches = await TeamKnockoutMatches.countDocuments({
        tournamentId,
      });
      const completedMatches = await TeamKnockoutMatches.countDocuments({
        tournamentId,
        status: { $in: ["COMPLETED", "BYE"] },
      });
      const activeMatches = await TeamKnockoutMatches.countDocuments({
        tournamentId,
        status: { $in: ["SCHEDULED", "IN_PROGRESS"] },
      });

      // Get current round info
      const maxRound = await TeamKnockoutMatches.aggregate([
        { $match: { tournamentId: new mongoose.Types.ObjectId(tournamentId) } },
        { $group: { _id: null, maxRound: { $max: "$round" } } },
      ]);

      // Get active matches for current round
      const currentRound = maxRound[0]?.maxRound || 1;
      const currentRoundMatches = await TeamKnockoutMatches.find({
        tournamentId,
        round: currentRound,
        status: { $in: ["SCHEDULED", "IN_PROGRESS"] },
      }).populate("team1Id team2Id");

      return res.status(200).json({
        success: true,
        statistics: {
          teams: {
            total: totalTeams,
            active: activeTeams,
            eliminated: eliminatedTeams,
          },
          matches: {
            total: totalMatches,
            completed: completedMatches,
            active: activeMatches,
          },
          tournament: {
            currentRound,
            maxRound: maxRound[0]?.maxRound || 1,
            isComplete: activeTeams <= 1,
          },
          currentRoundMatches,
        },
      });
    } catch (error) {
      console.error("Error fetching tournament statistics:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching tournament statistics",
        error: error.message,
      });
    }
  },

  getMatchStatistics: async (req, res) => {
    try {
      const { matchId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(matchId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid match ID",
        });
      }

      const match = await TeamKnockoutMatches.findById(matchId).populate(
        "team1Id team2Id winnerId"
      );

      if (!match) {
        return res.status(404).json({
          success: false,
          message: "Match not found",
        });
      }

      // Calculate match statistics
      const totalSets = match.sets.length;
      const completedSets = match.sets.filter(
        (s) => s.status === "COMPLETED"
      ).length;
      const totalGames = match.sets.reduce(
        (acc, set) => acc + set.games.length,
        0
      );
      const completedGames = match.sets.reduce(
        (acc, set) =>
          acc + set.games.filter((g) => g.status === "COMPLETED").length,
        0
      );

      const matchDuration =
        match.completedAt && match.createdAt
          ? Math.round((match.completedAt - match.createdAt) / (1000 * 60)) // minutes
          : null;

      // Calculate points statistics
      const pointsStatistics = match.sets.map((set) => ({
        setNumber: set.setNumber,
        type: set.type,
        totalGames: set.games.length,
        completedGames: set.games.filter((g) => g.status === "COMPLETED")
          .length,
        homeGamesWon: set.gamesWon.home,
        awayGamesWon: set.gamesWon.away,
        setWinner: set.setWinner,
        games: set.games.map((game) => ({
          gameNumber: game.gameNumber,
          homePoints: game.homePoints,
          awayPoints: game.awayPoints,
          winner: game.winner,
          status: game.status,
        })),
      }));

      return res.status(200).json({
        success: true,
        match,
        statistics: {
          overview: {
            totalSets,
            completedSets,
            totalGames,
            completedGames,
            matchDuration,
            setsWon: match.setsWon,
            matchWinner: match.matchWinner,
            status: match.status,
          },
          sets: pointsStatistics,
          liveState: match.liveState,
        },
      });
    } catch (error) {
      console.error("Error fetching match statistics:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching match statistics",
        error: error.message,
      });
    }
  },

  // ================================
  // COMPATIBILITY ROUTES
  // ================================

  // Route to maintain compatibility with existing frontend
  getBookingTeams: async (req, res) => {
    try {
      const { tournamentId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(tournamentId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid tournament ID format",
        });
      }

      // Check if teams already exist in our system
      let teams = await TeamKnockoutTeams.find({ tournamentId });

      if (teams.length === 0) {
        // Fetch from bookings if teams don't exist
        const bookings = await Booking.find({
          tournamentId: tournamentId,
          "team.name": { $exists: true },
        }).sort({ createdAt: -1 });

        // Transform bookings to expected format
        const transformedBookings = bookings.map((booking) => ({
          _id: booking._id,
          team: {
            name: booking.team.name,
            captain: booking.team.captain?.name || booking.team.captain,
            players: (booking.team.players || []).map((p) => p.name || p),
            substitutes: (booking.team.substitutes || []).map(
              (s) => s.name || s
            ),
          },
          createdAt: booking.createdAt,
        }));

        return res.json({
          success: true,
          bookings: transformedBookings,
        });
      } else {
        // Transform team records to booking format for frontend compatibility
        const transformedBookings = teams.map((team) => ({
          _id: team.originalBookingId,
          team: {
            name: team.teamName,
            captain: team.playerPositions.A,
            players: [team.playerPositions.B, team.playerPositions.C],
            substitutes: team.substitutes,
          },
          createdAt: team.createdAt,
        }));

        return res.json({
          success: true,
          bookings: transformedBookings,
        });
      }
    } catch (error) {
      console.error("Error fetching tournament teams:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching tournament teams",
        error: error.message,
      });
    }
  },

  // ================================
  // RESET & CLEANUP
  // ================================

  resetTournament: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { tournamentId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(tournamentId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid tournament ID",
        });
      }

      // Delete all matches
      await TeamKnockoutMatches.deleteMany({ tournamentId }, { session });

      // Delete all teams
      await TeamKnockoutTeams.deleteMany({ tournamentId }, { session });

      await session.commitTransaction();

      return res.status(200).json({
        success: true,
        message: "Tournament reset successfully",
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error resetting tournament:", error);
      return res.status(500).json({
        success: false,
        message: "Error resetting tournament",
        error: error.message,
      });
    } finally {
      session.endSession();
    }
  },

  // ================================
  // BULK SCORE UPLOAD FOR TEAM KNOCKOUT
  // ================================

  bulkUploadScores: async (req, res) => {
    try {
      const { tournamentId, scores } = req.body;

      if (!tournamentId || !scores || !Array.isArray(scores) || scores.length === 0) {
        return res.status(400).json({
          success: false,
          message: "tournamentId and scores array are required",
        });
      }

      const results = [];
      const errors = [];

      for (const entry of scores) {
        const { matchId, sets: setScores } = entry;

        if (!matchId || !setScores || !Array.isArray(setScores) || setScores.length === 0) {
          errors.push({ matchId, error: "matchId and sets array are required" });
          continue;
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          const match = await TeamKnockoutMatches.findById(matchId).session(session);
          if (!match) {
            errors.push({ matchId, error: "Match not found" });
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          if (match.status === "COMPLETED") {
            errors.push({ matchId, error: "Match already completed" });
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          if (match.isBye) {
            errors.push({ matchId, error: "Cannot score a bye match" });
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          // Sport-aware guard: team-KO bulk collects per-SET scores, so it only
          // fits set-based team events (racquet doubles / Davis Cup). A non-set
          // team match (cricket innings, football goals) would silently record
          // fake sets — reject cleanly so it's scored with the live scorer.
          const _tkScoringType = (match.scoringType || "sets").toLowerCase();
          if (_tkScoringType !== "sets") {
            errors.push({ matchId, error: `Bulk score upload isn't available for ${_tkScoringType} scoring. Use the live scorer.` });
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          const setsNeeded = getSetsRequiredToWin(match.formatId || match.format, match);
          const gamesNeeded = getGamesRequiredToWin(match);

          // Validate enough sets
          let homeWins = 0, awayWins = 0;
          for (const s of setScores) {
            if (s.player1Score === s.player2Score) {
              errors.push({ matchId, error: "Set scores cannot be tied" });
              await session.abortTransaction();
              session.endSession();
              continue;
            }
            if (s.player1Score > s.player2Score) homeWins++;
            else awayWins++;
          }

          if (homeWins < setsNeeded && awayWins < setsNeeded) {
            errors.push({ matchId, error: `Not enough sets. Need ${setsNeeded} to win.` });
            await session.abortTransaction();
            session.endSession();
            continue;
          }

          // Apply scores to each set
          let homeSetsWon = 0, awaySetsWon = 0;
          let matchDone = false;

          for (let i = 0; i < setScores.length && !matchDone; i++) {
            const setScore = setScores[i];
            const setIdx = i;

            if (setIdx >= match.sets.length) break;

            const currentSet = match.sets[setIdx];

            // Create a single completed game in this set
            const gameWinner = setScore.player1Score > setScore.player2Score ? "home" : "away";
            currentSet.games = [{
              gameNumber: 1,
              homePoints: setScore.player1Score,
              awayPoints: setScore.player2Score,
              winner: gameWinner,
              status: "COMPLETED",
              startTime: new Date(),
              endTime: new Date(),
            }];

            currentSet.gamesWon = {
              home: gameWinner === "home" ? 1 : 0,
              away: gameWinner === "away" ? 1 : 0,
            };
            currentSet.setWinner = gameWinner;
            currentSet.status = "COMPLETED";

            if (gameWinner === "home") homeSetsWon++;
            else awaySetsWon++;

            if (homeSetsWon >= setsNeeded || awaySetsWon >= setsNeeded) {
              matchDone = true;
            }
          }

          // Update match
          match.setsWon = { home: homeSetsWon, away: awaySetsWon };
          match.matchWinner = homeSetsWon >= setsNeeded ? "home" : "away";
          match.winnerId = match.matchWinner === "home" ? match.team1Id : match.team2Id;
          match.status = "COMPLETED";
          match.completedAt = new Date();

          // Update team stats
          const winnerTeamId = match.matchWinner === "home" ? match.team1Id : match.team2Id;
          const loserTeamId = match.matchWinner === "home" ? match.team2Id : match.team1Id;

          const winnerTeam = await TeamKnockoutTeams.findById(winnerTeamId).session(session);
          const loserTeam = await TeamKnockoutTeams.findById(loserTeamId).session(session);

          if (winnerTeam) {
            winnerTeam.matchesWon += 1;
            winnerTeam.setsWon += match.matchWinner === "home" ? homeSetsWon : awaySetsWon;
            winnerTeam.setsLost += match.matchWinner === "home" ? awaySetsWon : homeSetsWon;
            await winnerTeam.save({ session });
          }

          if (loserTeam) {
            loserTeam.matchesLost += 1;
            loserTeam.status = "ELIMINATED";
            loserTeam.setsWon += match.matchWinner === "home" ? awaySetsWon : homeSetsWon;
            loserTeam.setsLost += match.matchWinner === "home" ? homeSetsWon : awaySetsWon;
            await loserTeam.save({ session });
          }

          await match.save({ session });
          await session.commitTransaction();
          session.endSession();

          // Get team names for results
          const team1 = await TeamKnockoutTeams.findById(match.team1Id);
          const team2 = await TeamKnockoutTeams.findById(match.team2Id);

          results.push({
            matchId,
            team1: team1?.teamName || "Team 1",
            team2: team2?.teamName || "Team 2",
            winner: match.matchWinner === "home" ? (team1?.teamName || "Team 1") : (team2?.teamName || "Team 2"),
            finalScore: `${homeSetsWon}-${awaySetsWon}`,
            status: "success",
          });

        } catch (matchErr) {
          console.error(`[TEAM_BULK_SCORE] Error processing match ${matchId}:`, matchErr.message);
          await session.abortTransaction();
          session.endSession();
          errors.push({ matchId, error: matchErr.message });
        }
      }

      res.status(200).json({
        success: true,
        message: `Bulk score upload complete. ${results.length} matches updated, ${errors.length} errors.`,
        results,
        errors,
      });

    } catch (error) {
      console.error("[TEAM_BULK_SCORE_UPLOAD] Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to bulk upload scores",
        error: error.message,
      });
    }
  },

  // ================================
  // CAPTAIN DOUBLES SELECTION
  // ================================

  selectDoublesPairing: async (req, res) => {
    try {
      const { matchId } = req.params;
      const { setNumber, selectionId } = req.body;

      if (!matchId || !setNumber || !selectionId) {
        return res.status(400).json({ success: false, message: "matchId, setNumber, and selectionId are required" });
      }

      const match = await TeamKnockoutMatches.findById(matchId)
        .populate("team1Id")
        .populate("team2Id");

      if (!match) return res.status(404).json({ success: false, message: "Match not found" });
      if (match.status === "COMPLETED") return res.status(400).json({ success: false, message: "Match already completed" });

      // Get format config
      let formatConfig;
      try {
        formatConfig = getFormat(match.formatId);
      } catch {
        return res.status(400).json({ success: false, message: "Invalid format ID on match" });
      }

      // Find the set definition in config
      const setDef = formatConfig.sets.find((s) => s.setNumber === setNumber);
      if (!setDef) return res.status(400).json({ success: false, message: `Set ${setNumber} not found in format` });
      if (!setDef.requiresSelection) return res.status(400).json({ success: false, message: `Set ${setNumber} does not require selection` });

      // Validate selectionId exists in options
      const option = (setDef.options || []).find((o) => o.id === selectionId);
      if (!option) return res.status(400).json({ success: false, message: `Invalid selection: "${selectionId}"` });

      // Resolve players from rosters
      const resolved = resolveSetPlayers(setDef, match.team1Id, match.team2Id, selectionId);

      // Update the set in the match
      const setIdx = match.sets.findIndex((s) => s.setNumber === setNumber);
      if (setIdx === -1) return res.status(400).json({ success: false, message: `Set ${setNumber} not found in match` });

      match.sets[setIdx].selectionId = selectionId;
      match.sets[setIdx].type = resolved.type;
      match.sets[setIdx].homePlayer = resolved.homePlayer;
      match.sets[setIdx].awayPlayer = resolved.awayPlayer;
      match.sets[setIdx].homePlayerB = resolved.homePlayerB;
      match.sets[setIdx].awayPlayerB = resolved.awayPlayerB;

      await match.save({ validateModifiedOnly: true });

      res.json({
        success: true,
        message: `Doubles pairing selected for Set ${setNumber}`,
        set: match.sets[setIdx],
      });
    } catch (error) {
      console.error("Error selecting doubles pairing:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // Rapid Rallies — lock a captain's dynamic pick (a doubles partner for
  // rubber 2/4, or the rubber-5 singles player) for one side. Enforces the full
  // rule-set incrementally so a captain can never reach an invalid lineup.
  selectRapidRalliesPick: async (req, res) => {
    try {
      const { matchId } = req.params;
      const { side, setNumber, slot } = req.body;

      if (!matchId || !side || !setNumber || !slot) {
        return res.status(400).json({ success: false, message: "matchId, side, setNumber and slot are required" });
      }
      if (!["home", "away"].includes(side)) {
        return res.status(400).json({ success: false, message: "side must be 'home' or 'away'" });
      }

      const FIELD_BY_SET = { 2: "partner2", 4: "partner4", 5: "singles5" };
      const field = FIELD_BY_SET[Number(setNumber)];
      if (!field) {
        return res.status(400).json({ success: false, message: `Rubber ${setNumber} has no captain selection` });
      }

      const match = await TeamKnockoutMatches.findById(matchId)
        .populate("team1Id")
        .populate("team2Id");
      if (!match) return res.status(404).json({ success: false, message: "Match not found" });
      if (match.status === "COMPLETED") return res.status(400).json({ success: false, message: "Match already completed" });

      let fmt = null;
      try { fmt = getFormat(match.formatId); } catch { /* legacy */ }
      if (!isRapidRalliesFormat(fmt)) {
        return res.status(400).json({ success: false, message: "This match is not a Rapid Rallies tie" });
      }

      // A pick locks once its rubber has started.
      const targetSet = match.sets.find((s) => s.setNumber === Number(setNumber));
      if (!targetSet) return res.status(400).json({ success: false, message: `Rubber ${setNumber} not found` });
      if (targetSet.status && targetSet.status !== "PENDING") {
        return res.status(400).json({ success: false, message: `Rubber ${setNumber} has already started — the pick is locked.` });
      }

      // Validate the new pick against this side's OTHER already-locked picks.
      const selections = match.rrSelections || { home: {}, away: {} };
      const sidePartial = { ...(selections[side] || {}) };
      delete sidePartial[field];
      const allowed = RRLineup.validOptionsFor(side, field, sidePartial);
      if (!allowed.includes(slot)) {
        return res.status(400).json({
          success: false,
          message: `"${slot}" is not a valid pick for rubber ${setNumber} — it would break the lineup rules. Allowed: ${allowed.join(", ") || "none"}.`,
          allowed,
        });
      }

      // Persist the pick and reflect it on the affected rubber.
      selections[side] = { ...(selections[side] || {}), [field]: slot };
      match.rrSelections = selections;

      const team = side === "home" ? match.team1Id : match.team2Id;
      const playerName = slotMapFromTeam(team)[slot] || null;

      if (field === "singles5") {
        if (side === "home") targetSet.homePlayer = playerName;
        else targetSet.awayPlayer = playerName;
      } else {
        // doubles partner — the anchor stays in homePlayer/awayPlayer
        if (side === "home") targetSet.homePlayerB = playerName;
        else targetSet.awayPlayerB = playerName;
      }

      match.markModified("sets");
      match.markModified("rrSelections");
      await match.save({ validateModifiedOnly: true });

      return res.json({
        success: true,
        message: `${side} pick locked for rubber ${setNumber}.`,
        rrSelections: match.rrSelections,
        set: targetSet,
      });
    } catch (error) {
      console.error("Error selecting Rapid Rallies pick:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // Rapid Rallies — the legal picks per side/rubber given what's already locked.
  // Powers the manager lineup UI: it renders one dropdown per rubber/side from
  // `options`, so an illegal pick is never even offered.
  getRapidRalliesOptions: async (req, res) => {
    try {
      const { matchId } = req.params;
      const match = await TeamKnockoutMatches.findById(matchId)
        .populate("team1Id")
        .populate("team2Id");
      if (!match) return res.status(404).json({ success: false, message: "Match not found" });

      let fmt = null;
      try { fmt = getFormat(match.formatId); } catch { /* legacy */ }
      if (!isRapidRalliesFormat(fmt)) {
        return res.status(400).json({ success: false, message: "This match is not a Rapid Rallies tie" });
      }

      const selections = match.rrSelections || { home: {}, away: {} };
      const buildSide = (side, team) => {
        const slotMap = slotMapFromTeam(team);
        const cur = selections[side] || {};
        const fieldInfo = (field) => {
          const partial = { ...cur };
          delete partial[field];
          const options = RRLineup.validOptionsFor(side, field, partial).map((slot) => ({ slot, name: slotMap[slot] || slot }));
          return {
            locked: cur[field] || null,
            lockedName: cur[field] ? (slotMap[cur[field]] || cur[field]) : null,
            options,
          };
        };
        return {
          teamName: team?.teamName || null,
          slotMap,
          partner2: fieldInfo("partner2"),
          partner4: fieldInfo("partner4"),
          singles5: fieldInfo("singles5"),
        };
      };

      return res.json({
        success: true,
        data: {
          matchId: match._id,
          formatId: match.formatId,
          femaleSlot: fmt.femaleSlot,
          rrSelections: selections,
          rubberStatus: match.sets.map((s) => ({ setNumber: s.setNumber, status: s.status })),
          home: buildSide("home", match.team1Id),
          away: buildSide("away", match.team2Id),
        },
      });
    } catch (error) {
      console.error("Error getting Rapid Rallies options:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // Rapid Rallies — register a team with a full 5-slot roster (P1..P5 + gender).
  // Self-contained for the web-managed corporate flow: writes TeamKnockoutTeams
  // directly (position = slot) so the round-robin generator can read roster[].
  registerRapidRalliesTeam: async (req, res) => {
    try {
      const { tournamentId, teamName, players, sportId, teamId } = req.body;

      if (!tournamentId || !teamName || !Array.isArray(players) || players.length !== 5) {
        return res.status(400).json({ success: false, message: "tournamentId, teamName and exactly 5 players are required" });
      }

      const tournament = await Tournament.findById(tournamentId).lean();
      if (!tournament) return res.status(404).json({ success: false, message: "Tournament not found" });

      const { getDavisCupFormatId, resolveSportId } = require("../utils/sportTrackUtils");
      const fmtId = getDavisCupFormatId(tournament, resolveSportId(tournament, sportId));
      let fmt = null;
      try { fmt = getFormat(fmtId); } catch { /* legacy */ }
      if (!isRapidRalliesFormat(fmt)) {
        return res.status(400).json({ success: false, message: "This tournament is not a Rapid Rallies tie" });
      }

      const roster = players.map((p, i) => ({
        name: (p.name || "").trim(),
        gender: p.gender,
        position: `P${i + 1}`,
        role: i === 0 ? "captain" : "player",
      }));

      // Validate against the shared rule-set (5 named players, P3 female).
      const genderMap = {};
      roster.forEach((r) => { genderMap[r.position] = { name: r.name, gender: r.gender }; });
      const check = RRLineup.validateRoster(genderMap);
      if (!check.valid) {
        return res.status(400).json({ success: false, message: check.errors.join(" ") });
      }

      // Block editing once the league fixtures exist (rosters are frozen).
      const rrExists = await TeamKnockoutMatches.countDocuments({ tournamentId, round: 0 });
      if (rrExists > 0) {
        return res.status(400).json({ success: false, message: "Round-robin fixtures already generated — delete them before changing teams." });
      }

      const payload = {
        tournamentId,
        teamName: teamName.trim(),
        playerPositions: { A: roster[0].name, B: roster[1].name, C: roster[2].name },
        roster,
        teamSize: 5,
        status: "ACTIVE",
      };

      let team;
      if (teamId) {
        team = await TeamKnockoutTeams.findByIdAndUpdate(teamId, payload, { new: true });
        if (!team) return res.status(404).json({ success: false, message: "Team not found" });
      } else {
        team = await TeamKnockoutTeams.create({ ...payload, originalBookingId: new mongoose.Types.ObjectId() });
      }

      return res.status(teamId ? 200 : 201).json({ success: true, message: teamId ? "Team updated" : "Team registered", team });
    } catch (error) {
      console.error("Error registering Rapid Rallies team:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  },

  // ================================
  // HEALTH CHECK
  // ================================

  healthCheck: async (req, res) => {
    try {
      // Test database connections
      const teamsCount = await TeamKnockoutTeams.countDocuments();
      const matchesCount = await TeamKnockoutMatches.countDocuments();

      return res.status(200).json({
        success: true,
        message: "Team Knockout system is healthy",
        data: {
          teamsCount,
          matchesCount,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      console.error("Health check failed:", error);
      return res.status(500).json({
        success: false,
        message: "Health check failed",
        error: error.message,
      });
    }
  },
};

module.exports = teamKnockoutController;

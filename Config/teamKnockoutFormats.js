/**
 * Server-side Team Knockout Format Registry.
 * Single source of truth — identical to frontend config.
 * All match generation uses this directly. No legacy mapping.
 */

const TEAM_KNOCKOUT_FORMATS = [
  // 2-Player Singles
  {
    id: "singles_bo3", name: "Singles — Best of 3", totalSets: 3, setsToWin: 2, hasDoubles: false, minPlayers: 2,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "singles", homePos: ["A"], awayPos: ["B"], isDecider: true },
    ],
  },
  {
    id: "singles_bo5", name: "Singles — Best of 5", totalSets: 5, setsToWin: 3, hasDoubles: false, minPlayers: 2,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "singles", homePos: ["A"], awayPos: ["B"] },
      { setNumber: 4, type: "singles", homePos: ["B"], awayPos: ["A"] },
      { setNumber: 5, type: "singles", homePos: ["A"], awayPos: ["A"], isDecider: true },
    ],
  },
  {
    id: "singles_bo7", name: "Singles — Best of 7", totalSets: 7, setsToWin: 4, hasDoubles: false, minPlayers: 2,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "singles", homePos: ["A"], awayPos: ["B"] },
      { setNumber: 4, type: "singles", homePos: ["B"], awayPos: ["A"] },
      { setNumber: 5, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 6, type: "singles", homePos: ["B"], awayPos: ["B"], isDecider: true },
      { setNumber: 7, type: "singles", homePos: ["A"], awayPos: ["B"], isDecider: true },
    ],
  },
  // 2-Player Doubles (Mixed)
  {
    id: "doubles_bo3", name: "Doubles — Best of 3", totalSets: 3, setsToWin: 2, hasDoubles: true, minPlayers: 2,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "doubles", homePos: ["A", "B"], awayPos: ["A", "B"] },
      { setNumber: 3, type: "singles", homePos: ["B"], awayPos: ["B"], isDecider: true },
    ],
  },
  {
    id: "doubles_bo5", name: "Doubles — Best of 5", totalSets: 5, setsToWin: 3, hasDoubles: true, minPlayers: 2,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "doubles", homePos: ["A", "B"], awayPos: ["A", "B"] },
      { setNumber: 4, type: "singles", homePos: ["A"], awayPos: ["B"] },
      { setNumber: 5, type: "singles", homePos: ["B"], awayPos: ["A"], isDecider: true },
    ],
  },
  {
    id: "doubles_bo7", name: "Doubles — Best of 7", totalSets: 7, setsToWin: 4, hasDoubles: true, minPlayers: 2,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "doubles", homePos: ["A", "B"], awayPos: ["A", "B"] },
      { setNumber: 4, type: "singles", homePos: ["A"], awayPos: ["B"] },
      { setNumber: 5, type: "singles", homePos: ["B"], awayPos: ["A"] },
      { setNumber: 6, type: "doubles", homePos: ["A", "B"], awayPos: ["A", "B"], isDecider: true },
      { setNumber: 7, type: "singles", homePos: ["A"], awayPos: ["A"], isDecider: true },
    ],
  },
  // 3-Player Singles
  {
    id: "singles_3p_bo3", name: "3-Player Singles — Best of 3", totalSets: 3, setsToWin: 2, hasDoubles: false, minPlayers: 3,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "singles", homePos: ["C"], awayPos: ["C"], isDecider: true },
    ],
  },
  {
    id: "singles_3p_bo5", name: "3-Player Singles — Best of 5", totalSets: 5, setsToWin: 3, hasDoubles: false, minPlayers: 3,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "singles", homePos: ["C"], awayPos: ["C"] },
      { setNumber: 4, type: "singles", homePos: ["A"], awayPos: ["B"] },
      { setNumber: 5, type: "singles", homePos: ["B"], awayPos: ["C"], isDecider: true },
    ],
  },
  // 3-Player Mixed (Doubles with captain selection)
  {
    id: "doubles_3p_bo5", name: "3-Player Mixed — Best of 5", totalSets: 5, setsToWin: 3, hasDoubles: true, minPlayers: 3,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      {
        setNumber: 3, type: "doubles", isDecider: false,
        requiresSelection: true,
        defaultHomePos: ["B", "C"], defaultAwayPos: ["A", "B"],
        options: [
          { id: "bc_ab", homePos: ["B", "C"], awayPos: ["A", "B"] },
          { id: "ab_bc", homePos: ["A", "B"], awayPos: ["B", "C"] },
          { id: "ac_ac", homePos: ["A", "C"], awayPos: ["A", "C"] },
        ],
      },
      { setNumber: 4, type: "singles", homePos: ["A"], awayPos: ["B"] },
      { setNumber: 5, type: "singles", homePos: ["C"], awayPos: ["C"], isDecider: true },
    ],
  },
  {
    id: "doubles_3p_bo5_v2", name: "3-Player Mixed — Best of 5 (Classic)", totalSets: 5, setsToWin: 3, hasDoubles: true, minPlayers: 3,
    // Positions are roster slots A/B/C on BOTH sides (away A/B/C display as X/Y/Z).
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      {
        setNumber: 3, type: "doubles", isDecider: false,
        requiresSelection: true,
        defaultHomePos: ["A", "B"], defaultAwayPos: ["A", "C"],
        options: [
          { id: "ab_xz", homePos: ["A", "B"], awayPos: ["A", "C"] },
          { id: "bc_yx", homePos: ["B", "C"], awayPos: ["B", "A"] },
          { id: "ac_xy", homePos: ["A", "C"], awayPos: ["A", "B"] },
        ],
      },
      { setNumber: 4, type: "singles", homePos: ["A"], awayPos: ["B"] },
      { setNumber: 5, type: "singles", homePos: ["C"], awayPos: ["C"], isDecider: true },
    ],
  },
  {
    id: "doubles_3p_bo7", name: "3-Player Mixed — Best of 7", totalSets: 7, setsToWin: 4, hasDoubles: true, minPlayers: 3,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["A"], awayPos: ["A"] },
      { setNumber: 2, type: "singles", homePos: ["B"], awayPos: ["B"] },
      { setNumber: 3, type: "singles", homePos: ["C"], awayPos: ["C"] },
      {
        setNumber: 4, type: "doubles", isDecider: false,
        requiresSelection: true,
        defaultHomePos: ["A", "B"], defaultAwayPos: ["A", "B"],
        options: [
          { id: "ab_ab", homePos: ["A", "B"], awayPos: ["A", "B"] },
          { id: "ac_ac", homePos: ["A", "C"], awayPos: ["A", "C"] },
          { id: "bc_bc", homePos: ["B", "C"], awayPos: ["B", "C"] },
        ],
      },
      { setNumber: 5, type: "singles", homePos: ["A"], awayPos: ["B"] },
      {
        setNumber: 6, type: "doubles", isDecider: true,
        requiresSelection: true,
        defaultHomePos: ["B", "C"], defaultAwayPos: ["A", "B"],
        options: [
          { id: "bc_ab2", homePos: ["B", "C"], awayPos: ["A", "B"] },
          { id: "ac_bc2", homePos: ["A", "C"], awayPos: ["B", "C"] },
          { id: "ab_ac2", homePos: ["A", "B"], awayPos: ["A", "C"] },
        ],
      },
      { setNumber: 7, type: "singles", homePos: ["B"], awayPos: ["C"], isDecider: true },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // CSL 4.0 (Circles Sports League) tie formats.
  // Unlike the A/B/C rotation presets above, CSL uses LARGE rosters with a
  // DISTINCT player/pair per slot (P1..Pn), assigned via the captain's tie
  // sheet. Slot i (home) plays slot i (away). `setsToWin` decides the tie
  // winner; per the dossier ALL sub-matches are still played to earn points
  // (the points engine handles that — Phase 4).
  // ──────────────────────────────────────────────────────────────────
  {
    id: "csl_badminton", name: "CSL Badminton — 3 Doubles (21 pts)", totalSets: 3, setsToWin: 2,
    hasDoubles: true, minPlayers: 6, sport: "Badminton", pointsToWin: 21,
    sets: [
      { setNumber: 1, type: "doubles", homePos: ["P1", "P2"], awayPos: ["P1", "P2"] },
      { setNumber: 2, type: "doubles", homePos: ["P3", "P4"], awayPos: ["P3", "P4"] },
      { setNumber: 3, type: "doubles", homePos: ["P5", "P6"], awayPos: ["P5", "P6"] },
    ],
  },
  {
    id: "csl_table_tennis", name: "CSL Table Tennis — 7 Singles (+Impact, 11 pts)", totalSets: 7, setsToWin: 4,
    hasDoubles: false, minPlayers: 6, sport: "Table Tennis", pointsToWin: 11, hasImpactPlayer: true,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["P1"], awayPos: ["P1"] },
      { setNumber: 2, type: "singles", homePos: ["P2"], awayPos: ["P2"] },
      { setNumber: 3, type: "singles", homePos: ["P3"], awayPos: ["P3"] },
      { setNumber: 4, type: "singles", homePos: ["P4"], awayPos: ["P4"] },
      { setNumber: 5, type: "singles", homePos: ["P5"], awayPos: ["P5"] },
      { setNumber: 6, type: "singles", homePos: ["P6"], awayPos: ["P6"] },
      { setNumber: 7, type: "singles", homePos: ["IMPACT"], awayPos: ["IMPACT"], isImpact: true },
    ],
  },
  {
    id: "csl_carrom", name: "CSL Carrom — 5 Doubles (20min/4 boards/25 pts)", totalSets: 5, setsToWin: 3,
    hasDoubles: true, minPlayers: 10, sport: "Carrom",
    sets: [
      { setNumber: 1, type: "doubles", homePos: ["P1", "P2"], awayPos: ["P1", "P2"] },
      { setNumber: 2, type: "doubles", homePos: ["P3", "P4"], awayPos: ["P3", "P4"] },
      { setNumber: 3, type: "doubles", homePos: ["P5", "P6"], awayPos: ["P5", "P6"] },
      { setNumber: 4, type: "doubles", homePos: ["P7", "P8"], awayPos: ["P7", "P8"] },
      { setNumber: 5, type: "doubles", homePos: ["P9", "P10"], awayPos: ["P9", "P10"] },
    ],
  },
  {
    id: "csl_chess", name: "CSL Chess — 3 Boards (time-scored, 15 min/player)", totalSets: 3, setsToWin: 2,
    hasDoubles: false, minPlayers: 3, sport: "Chess", scoreBy: "time", minutesPerPlayer: 15,
    sets: [
      { setNumber: 1, type: "singles", homePos: ["P1"], awayPos: ["P1"] },
      { setNumber: 2, type: "singles", homePos: ["P2"], awayPos: ["P2"] },
      { setNumber: 3, type: "singles", homePos: ["P3"], awayPos: ["P3"] },
    ],
  },
  {
    id: "csl_pickleball", name: "CSL Pickle Ball — 5 Doubles (15 pts)", totalSets: 5, setsToWin: 3,
    hasDoubles: true, minPlayers: 10, sport: "Pickle Ball", pointsToWin: 15,
    sets: [
      { setNumber: 1, type: "doubles", homePos: ["P1", "P2"], awayPos: ["P1", "P2"] },
      { setNumber: 2, type: "doubles", homePos: ["P3", "P4"], awayPos: ["P3", "P4"] },
      { setNumber: 3, type: "doubles", homePos: ["P5", "P6"], awayPos: ["P5", "P6"] },
      { setNumber: 4, type: "doubles", homePos: ["P7", "P8"], awayPos: ["P7", "P8"] },
      { setNumber: 5, type: "doubles", homePos: ["P9", "P10"], awayPos: ["P9", "P10"] },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // RAPID RALLIES S1 (Kharadi TT) — 5-player roster, 5-rubber team tie.
  // Davis Cup style with a "Dynamic Selection System": doubles partners
  // and the rubber-5 singles player are chosen by the captain (up front OR
  // live per lineupMode). Constraints (female@P3, partner pool P3-P5,
  // all-5-play, rubber-5 not-played-singles) are enforced by
  // utils/rapidRalliesLineup.js — NOT by enumerated `options`.
  //
  // playAllSets: ALL 5 rubbers are always played (no dead rubbers); tie
  // winner = more rubbers won. See project_rapid_rallies_tt memory + plan.
  // ──────────────────────────────────────────────────────────────────
  {
    id: "rapid_rallies_s1",
    name: "Rapid Rallies S1 — 5-Player Dynamic",
    totalSets: 5, setsToWin: 3, hasDoubles: true, minPlayers: 5,
    sport: "Table Tennis", pointsToWin: 11,
    playAllSets: true,        // no dead rubbers — always play all 5
    femaleSlot: "P3",         // roster slot P3 must be female; plays rubber 3
    sets: [
      // Rubber 1 — Singles, cross-seed A1 vs B2
      { setNumber: 1, type: "singles", homePos: ["P1"], awayPos: ["P2"] },
      // Rubber 2 — Doubles, anchors P2(home)/P1(away) + partner from {P3,P4,P5}
      {
        setNumber: 2, type: "doubles", requiresSelection: true,
        homeAnchor: "P2", awayAnchor: "P1", partnerPool: ["P3", "P4", "P5"],
        defaultHomePos: ["P2", "P3"], defaultAwayPos: ["P1", "P3"],
      },
      // Rubber 3 — Singles (Female), always P3 vs P3
      { setNumber: 3, type: "singles", homePos: ["P3"], awayPos: ["P3"], female: true },
      // Rubber 4 — Doubles, anchors P1(home)/P2(away) + partner from {P3,P4,P5}
      {
        setNumber: 4, type: "doubles", requiresSelection: true,
        homeAnchor: "P1", awayAnchor: "P2", partnerPool: ["P3", "P4", "P5"],
        defaultHomePos: ["P1", "P3"], defaultAwayPos: ["P2", "P3"],
      },
      // Rubber 5 — Singles, P2/B1 or a player who has NOT played a singles rubber
      {
        setNumber: 5, type: "singles", requiresSelection: true,
        homeAnchor: "P2", awayAnchor: "P1",
        homeEligible: ["P2", "P4", "P5"], awayEligible: ["P1", "P4", "P5"],
        eligibility: "notPlayedSingles",
        defaultHomePos: ["P2"], defaultAwayPos: ["P1"], isDecider: true,
      },
    ],
  },
];

/**
 * Get format by ID.
 */
function getFormat(formatId) {
  const f = TEAM_KNOCKOUT_FORMATS.find((fmt) => fmt.id === formatId);
  if (!f) throw new Error(`Unknown team knockout format: "${formatId}"`);
  return f;
}

/**
 * Get all format IDs (for validation).
 */
function getAllFormatIds() {
  return TEAM_KNOCKOUT_FORMATS.map((f) => f.id);
}

/**
 * Resolve set players from team rosters.
 * Handles both fixed sets and requiresSelection sets.
 *
 * @param {object} setDef — set definition from format
 * @param {object} homeTeam — { playerPositions: { A, B, C } }
 * @param {object} awayTeam — { playerPositions: { A, B, C } }
 * @param {string|null} selectionId — captain's choice for doubles
 * @returns {{ homePlayer, awayPlayer, homePlayerB, awayPlayerB, type, setNumber }}
 */
function resolveSetPositions(setDef, selectionId = null) {
  if (setDef.requiresSelection && selectionId) {
    const option = (setDef.options || []).find((o) => o.id === selectionId);
    if (option) return { homePos: option.homePos, awayPos: option.awayPos };
  }
  return setDef.requiresSelection
    ? { homePos: setDef.defaultHomePos, awayPos: setDef.defaultAwayPos }
    : { homePos: setDef.homePos, awayPos: setDef.awayPos };
}

// Away roster slots A/B/C are shown as X/Y/Z ("Singles A-X", "Doubles AB-XY").
const AWAY_LABEL = { A: "X", B: "Y", C: "Z" };
const awayLabel = (positions) => positions.map((p) => AWAY_LABEL[p] || p).join("");

function resolveSetPlayers(setDef, homeTeam, awayTeam, selectionId = null) {
  const { homePos, awayPos } = resolveSetPositions(setDef, selectionId);

  const hp = homeTeam?.playerPositions || {};
  const ap = awayTeam?.playerPositions || {};

  const result = {
    setNumber: setDef.setNumber,
    type: setDef.type === "doubles"
      ? `Doubles ${homePos.join("")}-${awayLabel(awayPos)}`
      : `Singles ${homePos[0]}-${awayLabel(awayPos.slice(0, 1))}`,
    homePlayer: hp[homePos[0]] || null,
    awayPlayer: ap[awayPos[0]] || null,
    homePlayerB: homePos[1] ? (hp[homePos[1]] || null) : null,
    awayPlayerB: awayPos[1] ? (ap[awayPos[1]] || null) : null,
    status: "PENDING",
    games: [],
    gamesWon: { home: 0, away: 0 },
    setWinner: null,
  };

  return result;
}

/**
 * True when the format plays roster slot C (Z on the away side) anywhere.
 */
function needsThirdPlayer(formatId) {
  let f;
  try {
    f = getFormat(formatId);
  } catch {
    return false;
  }
  return f.sets.some((s) =>
    [
      ...(s.homePos || []), ...(s.awayPos || []),
      ...(s.defaultHomePos || []), ...(s.defaultAwayPos || []),
      ...(s.options || []).flatMap((o) => [...o.homePos, ...o.awayPos]),
    ].includes("C")
  );
}

module.exports = {
  TEAM_KNOCKOUT_FORMATS,
  getFormat,
  getAllFormatIds,
  resolveSetPositions,
  resolveSetPlayers,
  needsThirdPlayer,
};

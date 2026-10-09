const mongoose = require("mongoose");

const scoreSchema = new mongoose.Schema({
  matchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TournamentMatch",
    required: true,
  },
  playerA: { type: String, required: true },
  playerB: { type: String, required: true },
  setOne: { type: [Number], required: true },
  setTwo: { type: [Number], required: true },
  setThree: { type: [Number], required: true },
  winner: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Score = mongoose.model("Score", scoreSchema);

const playerSchema = new mongoose.Schema({
  playerName: { type: String, required: true },
  position: { type: String },
  image: String, // Assuming you want to upload an image for each player
});

module.exports = playerSchema;

const teamSchema = new mongoose.Schema({
  teamName: { type: String, required: true },
  logo: String,
  players: { type: [playerSchema], default: [] },
});

module.exports = teamSchema;

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  teams: { type: [teamSchema], default: [] },
});

module.exports = groupSchema;


// Per-sport track sub-schema. Each tournament can have one or more sports,
// and each sport entry holds its own categories, format, rule book, and
// stage progression. Legacy root scalars (sportsType, matchFormat, category,
// qualifyPerGroup, drawSize, currentStage, stageConfig, groupStageFormat,
// knockoutFormat, davisCupFormatId, sportRules, type) are kept during the
// migration window — sportTrackUtils transparently falls back to them.
const sportTrackSchema = new mongoose.Schema(
  {
    sportId: { type: mongoose.Schema.Types.ObjectId, ref: "Sport", required: true },
    sportName: { type: String, default: null },     // denormalized
    sportSlug: { type: String, default: null },     // denormalized

    // Per-sport tournament type — Badminton can be "knockout + group stage"
    // while Football is "knockout".
    type: {
      type: String,
      // "swiss" — fixed number of rounds, nobody eliminated, standings decide
      // the result. Additive: the existing values and their flows are unchanged.
      enum: ["knockout", "group stage", "knockout + group stage", "swiss"],
      default: null,
    },

    // Per-sport categories with their own fees and optional eligibility rules.
    // minAge / maxAge are inclusive caps on the player's age at tournament
    // start. minBirthDate / maxBirthDate are derived in utils/eligibility.js
    // from `tournament.startDate` at check time — not stored — so editing the
    // tournament date never leaves a stale cutoff behind.
    categories: [{
      // Reference to the CategoryTemplate this row was created from. Optional
      // for backward compatibility with categories created before templates
      // existed; new categories should always carry a templateId so the SA
      // can report usage. The age + gender fields below remain the source of
      // truth for the eligibility check — they are snapshots, so editing or
      // deactivating the template later never affects this tournament.
      templateId: { type: mongoose.Schema.Types.ObjectId, ref: "CategoryTemplate", default: null },
      name:   { type: String, required: true },
      fee:    { type: Number, required: true },
      minAge: { type: Number, default: null },
      maxAge: { type: Number, default: null },
      gender: { type: String, enum: ["male", "female", "any"], default: "any" },
      // Day this category is played ("YYYY-MM-DD", same format as the
      // tournament's startDate/endDate). Null = runs across the whole event.
      date:   { type: String, default: null },

      // Per-category format overrides. A sport track carries one format for
      // all its categories, which cannot express "Men's Singles is singles,
      // Men's Doubles is doubles" inside one Table Tennis track. When set,
      // these win over the sport-level values; when null the sport-level
      // value applies. Resolved through sportTrackUtils.getGroupStageFormat
      // — never read these directly.
      //
      // Enums mirror the sport-level fields below. They were previously
      // written to the database by seed scripts using the native driver, so
      // some documents already carry values here; declaring them makes those
      // values visible to non-lean queries and survivable across a save().
      type: {
        type: String,
        // "swiss" — fixed number of rounds, nobody eliminated, standings decide
        // the result. Additive: existing values and their flows are unchanged.
        enum: ["knockout", "group stage", "knockout + group stage", "swiss", null],
        default: null,
      },
      groupStageFormat: {
        type: String,
        enum: ["Singles", "Doubles", "Teams", null],
        default: null,
      },
      knockoutFormat: {
        type: String,
        enum: ["Singles", "Doubles", "Teams", "Teams Knockout", "Davis Cup", null],
        default: null,
      },

      // Structural progression settings, per category. A track carries one
      // qualifyPerGroup/drawSize for every category, which cannot express
      // "Men's Doubles advances the top 3, Women's Singles the top 2" inside
      // one track. Null means "use the track value" — same override rule as
      // the two format fields above, resolved through
      // sportTrackUtils.getQualifyPerGroup / getDrawSize.
      qualifyPerGroup: { type: Number, default: null },
      // Unlike the track-level field this one allows null in the enum: the
      // track's default is null-with-no-null-in-enum (see the note there),
      // but here null is the meaningful "inherit from track" value and has to
      // survive validation.
      drawSize: { type: Number, enum: [16, 32, 64, null], default: null },
    }],

    // Which level the manager declares format at for THIS sport, chosen in
    // step 2 of the create/edit wizard. "sport" keeps the historical flow
    // (one format for the whole track); "category" renders the format fields
    // under each category row instead. Purely a UI/authoring mode — the
    // resolvers below always prefer a category value when one is set, so a
    // track can be switched between modes without invalidating stored data.
    // Defaults to "sport" so every existing tournament is unchanged.
    formatScope: {
      type: String,
      enum: ["sport", "category"],
      default: "sport",
    },

    groupStageFormat: {
      type: String,
      enum: ["Singles", "Doubles", "Singles, Doubles", "Teams"],
      default: null,
    },
    knockoutFormat: {
      type: String,
      enum: ["Singles", "Doubles", "Singles, Doubles", "Teams", "Teams Knockout", "Davis Cup"],
      default: null,
    },
    davisCupFormatId: { type: String, default: null },

    // Lineup selection mode for team-tie formats with a "Dynamic Selection
    // System" (e.g. Rapid Rallies). "dynamic" = captain locks each doubles
    // partner / rubber-5 player right before that rubber (required mode).
    // "upfront" = whole lineup declared before the tie (optional, later).
    lineupMode: {
      type: String,
      enum: ["dynamic", "upfront"],
      default: "dynamic",
    },

    qualifyPerGroup: { type: Number, default: 2 },
    // No null in enum — Mongoose treats default:null + enum:[16,32,64] as a
    // skipped-validation case for unset values, avoiding the conflict that
    // arises when null is in the enum list.
    drawSize: { type: Number, enum: [16, 32, 64], default: null },

    // Per-sport tournament level — Football=state, Cricket=national,
    // TableTennis=unranked can coexist in one tournament. Empty string
    // means unset (legacy root tournamentLevel is used as fallback at
    // edit-load and create-time rule-book attach for backward compat).
    tournamentLevel: {
      type: String,
      enum: ["district", "state", "national", "international", "unranked", ""],
      default: "",
    },

    // Mirrors root tournament.matchFormat shape exactly.
    matchFormat: {
      totalSets: { type: Number, default: 3 },
      setsToWin: { type: Number, default: 2 },
      totalGames: { type: Number, default: 3 },
      gamesToWin: { type: Number, default: 2 },
      pointsToWinGame: { type: Number, default: null },
      marginToWin: { type: Number, default: null },
      deuceRule: { type: Boolean, default: true },
      maxPointsCap: { type: Number, default: null },
      tiebreakEnabled: { type: Boolean, default: false },
      tiebreakPoints: { type: Number, default: null },
      decidingSetPoints: { type: Number, default: null },
      serviceAlternate: { type: Number, default: 2 },
      oversCount: { type: Number, default: null },
      inningsCount: { type: Number, default: null },
      superOver: { type: Boolean, default: null },
      halvesCount: { type: Number, default: null },
      halvesDuration: { type: Number, default: null },
      quartersCount: { type: Number, default: null },
      quartersDuration: { type: Number, default: null },
      // Board-based sports (Carrom)
      boardsToWin: { type: Number, default: null },
      pointsPerBoard: { type: Number, default: null },
      queenValue: { type: Number, default: null },
      scoringType: { type: String, enum: ["sets", "innings", "time", "single", "board", null], default: null },
      formatVersion: { type: Number, default: 1 },
    },

    // Frozen rule-book copy for this sport. Mirrors root tournament.sportRules.
    sportRules: {
      ruleBookId: { type: mongoose.Schema.Types.ObjectId, ref: "SportRuleBook" },
      sportName: String,
      level: String,
      format: {
        totalSets: Number, pointsPerSet: Number, gamesPerSet: Number,
        pointsPerGame: Number, winByMargin: Number, maxPointsCap: Number,
        deuceEnabled: Boolean, tiebreakEnabled: Boolean, tiebreakPoints: Number,
        decidingSetPoints: Number, serviceAlternate: Number,
        oversCount: Number, inningsCount: Number, superOver: Boolean,
        halvesCount: Number, halvesDuration: Number,
        quartersCount: Number, quartersDuration: Number,
        boardsToWin: Number, pointsPerBoard: Number, queenValue: Number,
      },
      rules: {
        maxPlayersPerTeam: Number, minPlayersPerTeam: Number,
        substitutionsAllowed: Number, timeoutsPerSet: Number, timeoutDuration: Number,
        warmupTime: Number, matchDuration: Number, breakBetweenSets: Number,
        powerPlayOvers: Number, wideBallRule: Boolean, noBallFreeHit: Boolean,
        drsAvailable: Boolean, batsmenPerInnings: Number, letServeReplay: Boolean,
        serviceFaults: Number, sideChangeAfterPoints: Number,
        refereeRequired: Boolean, umpiresCount: Number, thirdUmpire: Boolean,
        lineJudges: Number, scorerRequired: Boolean,
      },
      equipment: {
        ballType: String, courtSize: String, netHeight: String,
        tableSize: String, racketSpec: String, boardSize: String,
      },
      isLocked: { type: Boolean, default: true },
    },

    // Per-sport stage progression — sports advance independently.
    currentStage: {
      type: String,
      enum: ["registration", "group_stage", "group_completed", "knockout", "completed"],
      default: "registration",
    },
    stageConfig: {
      qualifierKnockout: {
        enabled:   { type: Boolean, default: false },
        completed: { type: Boolean, default: false },
      },
      mainKnockout: {
        enabled:   { type: Boolean, default: false },
        completed: { type: Boolean, default: false },
      },
      groupStage: {
        completed: { type: Boolean, default: false },
      },
      // round2Format used to be a root-level dot-path field — folded in here.
      round2Format: { type: String, default: null },
    },
  },
  { _id: true, timestamps: true }
);


const tournamentSchema = new mongoose.Schema(
  {
    title: String,
    tournamentLogo: String,

    // STEP 17e — 13 root scalar fields removed. Per-sport equivalents
    // live on sports[i] (sportTrackSchema above). Removed:
    //   type, currentStage, qualifyPerGroup, drawSize, davisCupFormatId,
    //   sportsType, sportRules, groupStageFormat, knockoutFormat,
    //   category, setFormat, matchFormat, stageConfig.
    // Mongoose strict mode silently strips writes to undeclared fields;
    // existing legacy values in DB persist (visible only via .lean()
    // queries) until the STEP 17g $unset migration removes them.
    // Tournament-level metadata that stays at root: tournamentLevel (legacy
    // mirror of sports[0].tournamentLevel for the older edit modal),
    // rulesLockedAt, dates, organizer, location, etc. isCustomRules removed —
    // it was written at create time but never consumed anywhere; derive from
    // sports.some(s => s.tournamentLevel === "unranked") if needed.

    // Locked sport rules — auto-attached from SportRuleBook at creation
    tournamentLevel: {
      type: String,
      enum: ["district", "state", "national", "international", "unranked"],
      default: "district",
    },
    // Timestamp when rules were locked (after first match generated)
    rulesLockedAt: { type: Date, default: null },

    // Court / table catalog. Manager-defined free-text names — clubs label
    // their venues differently ("Court 1", "Table A", "South Lawn"). When
    // empty, match-generation flows fall back to the legacy single-court
    // input (backward compat). When populated, generation auto-distributes
    // matches round-robin across the active courts.
    //
    // sportId is null in v1 (tournament-wide pool serving every sport).
    // Schema already supports per-sport scoping for v2 — managers will be
    // able to assign a court to a specific sport without a migration.
    //
    // isActive=false soft-deletes a court — past match assignments still
    // display the name, but new generations skip it. No hard-delete in v1.
    courts: [{
      name:    { type: String, required: true, trim: true },
      type:    { type: String, default: null },                       // free-form: "indoor" | "outdoor" | "table" | null
      sportId: { type: mongoose.Schema.Types.ObjectId, ref: "Sport", default: null },
      isActive:{ type: Boolean, default: true },
      // Court-based umpire assignment: ONE umpire per court, responsible for
      // every match played on it. Authorization runs off this via
      // utils/umpireAuth.js (a 3rd path alongside per-match + stage-level).
      assignedUmpire: {
        refereeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        name:      { type: String, default: null },
      },
      createdAt:{ type: Date, default: Date.now },
    }],

    description: String,
    selectedTime: {
      startTime: String,
      endTime: String,
    },
    startDate: String,
    endDate: String,
    organizerName: String,
    cancellationPolicy: String,
    eventLocation: [{ type: String }],
    managerId: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Manager",
      },
    ],

    // ── Tenant key (Phase 1.1 multi-tenancy) ──
    // Owning club = a ClubAdmin/corporate_admin User _id (same convention as
    // Manager.clubId). Stamped on create from the request tenant context and via
    // scripts/backfillTournamentClubId.js. Additive/nullable during rollout;
    // scoping runs in SHADOW MODE (enforce:false) until backfilled + verified.
    clubId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // Per-sport tracks. Canonical source of all per-sport config:
    // sportName, type, categories, matchFormat, sportRules,
    // groupStageFormat, knockoutFormat, davisCupFormatId, drawSize,
    // qualifyPerGroup, currentStage, stageConfig.
    //
    // STEP 17f — required: true with min-1 validator. The 16b boundary
    // validator already enforces this on incoming writes; the schema
    // flip is belt-and-suspenders for direct ORM inserts (seed scripts,
    // shell, etc.). Audit confirms 0 tournaments with empty sports[].
    sports: {
      type: [sportTrackSchema],
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length >= 1,
        message: "Tournament.sports must contain at least one sport track.",
      },
    },

    // Registration deadline — last date/time for players to register
    registrationDeadline: { type: Date, default: null },

    termsAndConditions: String,
    // 🔹 New field
    turfs: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Turf",
        required: true,
      },
    ],

    // Private/Public visibility toggle
    isPrivate: {
      type: Boolean,
      default: false,
    },

    // Auto-generated or custom client ID for private tournaments
    clientId: {
      type: String,
      unique: true,
      sparse: true,
    },

    // 🔹 New field for Corporate Employee Whitelist
    whitelist: [
      {
        employeeId: { type: String },
        name: { type: String },
        mobile: { type: String },
      },
    ],

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);


// Multi-tenant scoping (Phase 1.1) — ENFORCED (2026-06-02).
// Backfill (scripts/backfillTournamentClubId.js: 15 updated, 0 skipped) +
// isolation proof (scripts/verifyTournamentTenancy.js: consistency clean,
// scoping correct) both passed. Club-staff queries are now auto-scoped to their
// clubId; players/public/SuperAdmin are unaffected. To revert, set enforce:false.
// NOTE: .aggregate() pipelines are NOT yet scoped by this plugin.
const tenantScope = require("../../../../utils/tenantScope");
tournamentSchema.plugin(tenantScope, { field: "clubId", enforce: true });

module.exports = mongoose.model("Tournament", tournamentSchema);

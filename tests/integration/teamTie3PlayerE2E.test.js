"use strict";
/**
 * End-to-end proof that a 3-player team tie ("ABC vs XYZ") generates the
 * rubbers a real score sheet expects.
 *
 * Modelled on an actual tie: GG International School inter-school table tennis,
 * U-11 Boys, 2026-27.
 *
 *     GGI Pimpri   A Jainil Gantrad   B Shravil Milke   C Arav Ghosh
 *     GGIS         X Arav             Y Mivaan          Z Manvik
 *
 *     1. A v X     2. B v Y     3. C v Z     4. A v Y     5. B v X
 *
 * The unit test (tests/unit/teamTieSwaythlingOrder.test.js) pins the CONFIG.
 * This one pins the OUTCOME: that the config actually reaches generated match
 * rows with the right players in the right rubbers — including the third
 * player, who was previously dropped whenever davisCupFormatId was unset.
 */
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// createTournamentFromBookings runs inside a mongo TRANSACTION, which needs a
// replica set — the plain in-memory server cannot do it.
const { startTxApp, stopTxApp, clearDatabase, getApp } = require("./setupReplset");

const Tournament = require("../../src/modules/tournaments/models/Tournament");
const Sport = require("../../src/modules/catalog/models/Sport");
const Booking = require("../../src/modules/tournaments/models/BookingModel");
const Superadminmodel = require("../../src/modules/identity/models/Superadminmodel");
const TeamKnockoutTeams = require("../../src/modules/tournaments/models/TeamKnockoutTeams");
const TeamKnockoutMatches = require("../../src/modules/tournaments/models/TeamKnockoutMatches");

const HOME = { A: "JAINIL GANTRAD", B: "SHRAVIL MILKE", C: "ARAV GHOSH" };
const AWAY = { A: "ARAV", B: "MIVAAN", C: "MANVIK" };

let saToken;
let sportId;
let tournamentId;

beforeAll(async () => {
  await startTxApp();
});
afterAll(stopTxApp);

beforeEach(async () => {
  await clearDatabase();

  // SuperAdmin bypasses requirePermission, so the test exercises the tie logic
  // rather than the RBAC graph. requireSuperAdmin resolves membership from the
  // collection, so a real row must exist.
  const sa = await Superadminmodel.create({
    email: "sa-tie@test.local",
    password: "hashed-not-used",
  });
  saToken = jwt.sign(
    { userId: String(sa._id), email: sa.email, role: "superadmin" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  const sport = await Sport.create({
    name: "Table Tennis",
    category: "Racquet",
    scoringType: "sets",
  });
  sportId = sport._id;

  const t = await Tournament.create({
    title: "TABLE TENNIS CHAMPIONSHIP",
    startDate: "2026-10-29",
    endDate: "2026-10-30",
    organizerName: "GG INTERNATIONAL SCHOOL",
    sports: [
      {
        sportId,
        sportName: "Table Tennis",
        sportSlug: "table-tennis",
        type: "knockout",
        knockoutFormat: "Davis Cup",
        // THE setting that makes slot C be collected at all.
        davisCupFormatId: "singles_3p_bo5",
        categories: [
          { name: "UNDER 11", fee: 0, minAge: 11, maxAge: 11, gender: "any", date: "2026-10-29" },
        ],
        matchFormat: {
          totalSets: 3, setsToWin: 2, totalGames: 3, gamesToWin: 2,
          pointsToWinGame: 11, marginToWin: 2, deuceRule: true,
          serviceAlternate: 2, scoringType: "sets",
        },
      },
    ],
  });
  tournamentId = t._id;
});

/** One booking per TEAM, carrying a 3-player roster. */
async function makeTeamBooking(teamName, roster) {
  return Booking.create({
    userName: teamName,
    isGuestBooking: true,
    tournamentId,
    tournamentName: "TABLE TENNIS CHAMPIONSHIP",
    status: "confirmed",
    paymentStatus: "waived",
    tournamentType: "Singles",
    // team.players is an array of SUB-DOCUMENTS ({ name, id, profileImage }),
    // not strings. getValidPlayers runs each through extractPlayerName.
    team: {
      name: teamName,
      players: [{ name: roster.A }, { name: roster.B }, { name: roster.C }],
      substitutes: [],
    },
    sportSelections: [
      { sportId, sportName: "Table Tennis", categoryName: "UNDER 11" },
    ],
  });
}

const createTie = (bookings) =>
  request(getApp())
    .post("/api/tournaments/team-knockout/create")
    .set("Authorization", `Bearer ${saToken}`)
    .send({
      tournamentId: String(tournamentId),
      sportId: String(sportId),
      selectedBookingIds: bookings.map((b) => String(b._id)),
      // The controller reads matchStartTime / matchInterval / courtNumber.
      scheduleDetails: {
        matchStartTime: "2026-10-29T10:00:00.000Z",
        matchInterval: 30,
        courtNumber: "T1",
      },
      tournamentType: "Singles",
      setCount: 5,
      // Mirrors what the web posts: raw booking team data, A/B/C split happens
      // server-side in getValidPlayers.
      cleanedTeamData: bookings.map((b) => ({
        _id: String(b._id),
        team: {
          name: b.team.name,
          players: b.team.players.map((p) => ({ name: p.name })),
          substitutes: [],
        },
      })),
    });

/**
 * Which roster ended up as home is NOT fixed — createTournamentFromBookings
 * shuffles teams before pairing them (teamKnockoutController ~line 547). So
 * these tests derive the sides from the generated match rather than assuming
 * an order; the rubber PATTERN is what is under test, not the draw.
 */
function sides(match) {
  const set1 = match.sets.find((s) => s.setNumber === 1);
  const homeIsPimpri = Object.values(HOME).includes(set1.homePlayer);
  const home = homeIsPimpri ? HOME : AWAY;
  const away = homeIsPimpri ? AWAY : HOME;
  return {
    home,
    away,
    label: (s) => {
      const H = { [home.A]: "A", [home.B]: "B", [home.C]: "C" };
      const X = { [away.A]: "X", [away.B]: "Y", [away.C]: "Z" };
      return `${H[s.homePlayer]}-${X[s.awayPlayer]}`;
    },
  };
}

test("a 3-player tie generates A-X, B-Y, C-Z, A-Y, B-X with the right players", async () => {
  const home = await makeTeamBooking("GGI PIMPRI", HOME);
  const away = await makeTeamBooking("GGIS", AWAY);

  const res = await createTie([home, away]);
  expect(res.status).toBeLessThan(400);

  // Both teams stored a THIRD player — the regression that matters most.
  const teams = await TeamKnockoutTeams.find({ tournamentId }).lean();
  expect(teams).toHaveLength(2);
  for (const t of teams) {
    expect(t.playerPositions.A).toBeTruthy();
    expect(t.playerPositions.B).toBeTruthy();
    expect(t.playerPositions.C).toBeTruthy(); // ← dropped when davisCupFormatId was null
  }

  const match = await TeamKnockoutMatches.findOne({ tournamentId }).lean();
  expect(match).toBeTruthy();
  expect(match.sets).toHaveLength(5);

  const { label } = sides(match);
  const rubbers = match.sets
    .slice()
    .sort((a, b) => a.setNumber - b.setNumber)
    .map(label);

  expect(rubbers).toEqual(["A-X", "B-Y", "C-Z", "A-Y", "B-X"]);
});

test("the third player actually appears in a rubber, by name", async () => {
  const home = await makeTeamBooking("GGI PIMPRI", HOME);
  const away = await makeTeamBooking("GGIS", AWAY);
  await createTie([home, away]);

  const match = await TeamKnockoutMatches.findOne({ tournamentId }).lean();
  const { home: hr, away: ar } = sides(match);
  const set3 = match.sets.find((s) => s.setNumber === 3);

  // The two third players. Before the fix they could be registered and never
  // play at all.
  expect(set3.homePlayer).toBe(hr.C);
  expect(set3.awayPlayer).toBe(ar.C);
  expect([HOME.C, AWAY.C]).toEqual(
    expect.arrayContaining([set3.homePlayer, set3.awayPlayer])
  );
});

test("the decider is B v X, not B v Z — each side used 2-2-1", async () => {
  const home = await makeTeamBooking("GGI PIMPRI", HOME);
  const away = await makeTeamBooking("GGIS", AWAY);
  await createTie([home, away]);

  const match = await TeamKnockoutMatches.findOne({ tournamentId }).lean();
  const { home: hr, away: ar } = sides(match);
  const set5 = match.sets.find((s) => s.setNumber === 5);

  expect(set5.homePlayer).toBe(hr.B);
  expect(set5.awayPlayer).toBe(ar.A); // X, the away FIRST player — not Z

  const count = (pick) => {
    const n = {};
    for (const s of match.sets) n[pick(s)] = (n[pick(s)] || 0) + 1;
    return n;
  };
  expect(count((s) => s.homePlayer)).toEqual({
    [hr.A]: 2, [hr.B]: 2, [hr.C]: 1,
  });
  expect(count((s) => s.awayPlayer)).toEqual({
    [ar.A]: 2, [ar.B]: 2, [ar.C]: 1,
  });
});

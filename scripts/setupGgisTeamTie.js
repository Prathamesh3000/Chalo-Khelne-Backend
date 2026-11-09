/**
 * One-off: put the GG International School U-11 table tennis tie into the app
 * as a 3-player ("ABC vs XYZ") team tie.
 *
 * WHY A SCRIPT AND NOT THE UI
 * ---------------------------
 * Neither frontend can enter roster slot C today (mobile caps racket-sport
 * rosters at 2 players; the web has no A/B/C roster editor). So the Manager
 * "Generate" button fails the `teamsMissingSlotC` guard with a 400 for any
 * 3-player format. This drives the REAL controller
 * (`createTournamentFromBookings`) with a synthetic req/res, so the same
 * validation, transaction and match generation run — only the browser is
 * missing.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply.
 *
 *   node scripts/setupGgisTeamTie.js
 *   node scripts/setupGgisTeamTie.js --apply
 *   node scripts/setupGgisTeamTie.js --revert --apply
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDb, disconnectDb } = require("./lib/connectDb");
const { runWithTenant } = require("../utils/tenantContext");

const Tournament = require("../src/modules/tournaments/models/Tournament");
const Booking = require("../src/modules/tournaments/models/BookingModel");
const TeamKnockoutTeams = require("../src/modules/tournaments/models/TeamKnockoutTeams");
const TeamKnockoutMatches = require("../src/modules/tournaments/models/TeamKnockoutMatches");
const teamKnockoutController = require("../controllers/teamKnockoutController");

const TOURNAMENT_ID = "6ae2e2692f7d16012067192f";
const SPORT_ID = "69b7ce0cf50e303a19ed6110";
const FORMAT_ID = "singles_3p_bo5";

// Rosters exactly as the paper score sheet has them, in A/B/C order.
const ROSTERS = [
  { name: "GGI PIMPRI", players: ["JAINIL GANTRAD", "SHRAVIL MILKE", "ARAV GHOSH"] },
  { name: "GGIS", players: ["ARAV", "MIVAAN", "MANVIK"] },
];

const apply = process.argv.includes("--apply");
const revert = process.argv.includes("--revert");

/** Minimal res stand-in so the controller can be called off-HTTP. */
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function main() {
  const tid = new mongoose.Types.ObjectId(TOURNAMENT_ID);

  const tournament = await Tournament.findById(tid).lean();
  if (!tournament) throw new Error(`Tournament ${TOURNAMENT_ID} not found`);
  const track = (tournament.sports || []).find((s) => String(s.sportId) === SPORT_ID);
  if (!track) throw new Error(`Sport track ${SPORT_ID} not found on the tournament`);

  const existingTeams = await TeamKnockoutTeams.countDocuments({ tournamentId: tid });
  const existingMatches = await TeamKnockoutMatches.countDocuments({ tournamentId: tid });

  console.log(`\nTournament : ${tournament.title}`);
  console.log(`Organizer  : ${tournament.organizerName}`);
  console.log(`Sport      : ${track.sportName}`);
  console.log(`\nCURRENT STATE`);
  console.log(`  knockoutFormat    : ${track.knockoutFormat}`);
  console.log(`  davisCupFormatId  : ${track.davisCupFormatId}`);
  console.log(`  teams             : ${existingTeams}`);
  console.log(`  matches           : ${existingMatches}`);

  // ── revert ──
  if (revert) {
    console.log(`\nREVERT${apply ? "" : "  [dry run]"}`);
    console.log(`  → knockoutFormat   back to "Singles"`);
    console.log(`  → davisCupFormatId back to null`);
    console.log(`  → delete ${existingTeams} team(s) and ${existingMatches} match(es)`);
    if (apply) {
      await Tournament.updateOne(
        { _id: tid, "sports.sportId": SPORT_ID },
        { $set: { "sports.$.knockoutFormat": "Singles", "sports.$.davisCupFormatId": null } }
      );
      await TeamKnockoutTeams.deleteMany({ tournamentId: tid });
      await TeamKnockoutMatches.deleteMany({ tournamentId: tid });
      console.log("  reverted.");
    } else {
      console.log("\n  Nothing written. Re-run with --apply.");
    }
    return;
  }

  if (existingTeams > 0 || existingMatches > 0) {
    // Repair rows written before the tenant fix above: they carry clubId:null
    // and are invisible to every scoped query the app makes.
    const db = mongoose.connection.db;
    const orphanM = await db.collection("teamknockoutmatches")
      .countDocuments({ tournamentId: tid, clubId: null });
    const orphanT = await db.collection("teamknockoutteams")
      .countDocuments({ tournamentId: tid, clubId: null });

    if (orphanM || orphanT) {
      console.log(`
REPAIR NEEDED${apply ? "" : "  [dry run]"}`);
      console.log(`  ${orphanM} match(es) and ${orphanT} team(s) have clubId:null`);
      console.log(`  -> stamp clubId = ${tournament.clubId}`);
      if (apply) {
        // Raw driver on purpose: the Mongoose models are tenant-scoped, so a
        // scoped update would filter out the very rows being repaired.
        const r1 = await db.collection("teamknockoutmatches")
          .updateMany({ tournamentId: tid, clubId: null }, { $set: { clubId: tournament.clubId } });
        const r2 = await db.collection("teamknockoutteams")
          .updateMany({ tournamentId: tid, clubId: null }, { $set: { clubId: tournament.clubId } });
        console.log(`  repaired ${r1.modifiedCount} match(es), ${r2.modifiedCount} team(s).`);
      } else {
        console.log(`
  Nothing written. Re-run with --apply.`);
      }
      return;
    }

    console.log(`
ALREADY SET UP - ${existingTeams} team(s), ${existingMatches} match(es), clubId stamped.`);
    console.log(`Run with --revert --apply to rebuild.`);
    return;
  }

  // Map each roster onto an anchor booking (the controller keys teams by a
  // booking id). Players are matched by the name on their own booking.
  const bookings = await Booking.find({ tournamentId: tid }).lean();
  const byName = new Map(bookings.map((b) => [String(b.userName).trim().toUpperCase(), b]));

  const cleanedTeamData = [];
  const missing = [];
  for (const roster of ROSTERS) {
    const anchor = byName.get(roster.players[0].toUpperCase());
    if (!anchor) { missing.push(roster.players[0]); continue; }
    for (const p of roster.players) {
      if (!byName.has(p.toUpperCase())) missing.push(p);
    }
    cleanedTeamData.push({
      _id: String(anchor._id),
      team: { name: roster.name, players: roster.players.map((name) => ({ name })), substitutes: [] },
    });
  }

  if (missing.length) {
    throw new Error(`These players are not registered in the tournament: ${missing.join(", ")}`);
  }

  console.log(`\nPLAN${apply ? "" : "  [dry run]"}`);
  console.log(`  1. set knockoutFormat   = "Davis Cup"`);
  console.log(`  2. set davisCupFormatId = "${FORMAT_ID}"`);
  console.log(`  3. create ${cleanedTeamData.length} teams and generate the tie:`);
  for (const t of cleanedTeamData) {
    const r = ROSTERS.find((x) => x.name === t.team.name);
    console.log(`       ${t.team.name.padEnd(12)} A=${r.players[0]}  B=${r.players[1]}  C=${r.players[2]}`);
  }
  console.log(`\n  resulting rubbers: A-X, B-Y, C-Z, A-Y, B-X  (best of 5)`);

  if (!apply) {
    console.log(`\n  Nothing written. Re-run with --apply to commit.`);
    return;
  }

  // 1 + 2 — the format must be set BEFORE creation: `includeC` is derived from
  // davisCupFormatId, and without it slot C is silently dropped.
  await Tournament.updateOne(
    { _id: tid, "sports.sportId": SPORT_ID },
    { $set: { "sports.$.knockoutFormat": "Davis Cup", "sports.$.davisCupFormatId": FORMAT_ID } }
  );
  console.log(`\n  format set.`);

  // 3 — real controller, real validation, real transaction.
  const req = {
    body: {
      tournamentId: TOURNAMENT_ID,
      sportId: SPORT_ID,
      selectedBookingIds: cleanedTeamData.map((t) => t._id),
      scheduleDetails: {
        matchStartTime: `${tournament.startDate}T10:00:00.000Z`,
        matchInterval: 30,
        courtNumber: "TT-1",
      },
      tournamentType: "Singles",
      setCount: 5,
      cleanedTeamData,
    },
  };
  const res = makeRes();
  // ── TENANT CONTEXT IS NOT OPTIONAL HERE ──
  // TeamKnockoutMatches and TeamKnockoutTeams both run
  // tenantScope(..., { enforce: true }). The plugin stamps clubId on insert
  // from the REQUEST's tenant context, which a script does not have. Created
  // without it every row lands with clubId:null, and the manager's own request
  // (whose context carries the club) gets where({clubId}) injected and cannot
  // see them — the UI shows 404 "Match not found" for a match that exists.
  await runWithTenant(
    { clubId: String(tournament.clubId), principalType: "ClubAdmin" },
    () => teamKnockoutController.createTournamentFromBookings(req, res)
  );

  if (res.statusCode >= 400) {
    throw new Error(`Controller refused (${res.statusCode}): ${res.body && res.body.message}`);
  }

  const teams = await TeamKnockoutTeams.find({ tournamentId: tid }).lean();
  const matches = await TeamKnockoutMatches.find({ tournamentId: tid }).lean();
  console.log(`  created ${teams.length} team(s), ${matches.length} match(es).\n`);

  for (const t of teams) {
    const p = t.playerPositions || {};
    console.log(`  ${String(t.teamName).padEnd(12)} A=${p.A}  B=${p.B}  C=${p.C}`);
  }
  for (const m of matches) {
    console.log(`\n  tie ${m.format} (${m.formatId}) — court ${m.courtNumber}`);
    for (const s of (m.sets || []).sort((a, b) => a.setNumber - b.setNumber)) {
      console.log(`    set ${s.setNumber}: ${String(s.homePlayer).padEnd(18)} v  ${s.awayPlayer}`);
    }
  }
}

connectDb()
  .then(main)
  .then(() => disconnectDb())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("\n[setupGgisTeamTie] FAILED:", e.message);
    try { await disconnectDb(); } catch (_) { /* already down */ }
    process.exit(1);
  });

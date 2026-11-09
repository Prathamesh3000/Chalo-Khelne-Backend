/**
 * Seeds demo playing-history entries for ONE user so timeline designs can be
 * compared with realistic data. Reversible: every inserted _id is written to
 * seedDemoHistory.ids.json and `--remove` deletes exactly those documents.
 *
 *   node scripts/seedDemoHistory.js <userId>            insert
 *   node scripts/seedDemoHistory.js --remove            delete what this script inserted
 *
 * Writes only to PlayerHistory, only for the given user. Uses MONGO_URI from .env.
 */
require('dotenv').config();
// Some networks refuse the SRV lookup Atlas needs; SEED_DNS=8.8.8.8 works around it for this script only.
if (process.env.SEED_DNS) require('dns').setServers(process.env.SEED_DNS.split(','));
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const PlayerHistory = require('../src/modules/social/models/PlayerHistory');
const User = require('../src/modules/identity/models/User');

const IDS_FILE = path.join(__dirname, 'seedDemoHistory.ids.json');

// A spread of years, a gap year (2023), two events on one day, wins / podiums /
// plain participation, verified and self-reported, with and without notes.
const DEMO = [
  { tournamentName: 'Pune Premier Badminton Open', sport: 'Badminton', location: 'Pune', eventDate: '2026-10-12', result: 'Winner', verified: true,
    description: 'Won the final 21-17, 21-19 after saving two match points in the semi-final.' },
  { tournamentName: 'Sunday Doubles Showdown', sport: 'Badminton', location: 'Baner', eventDate: '2026-10-12', result: 'Runner-up', verified: true },
  { tournamentName: 'Baner Turf Football Cup', sport: 'Football', location: 'Baner', eventDate: '2026-08-03', result: 'Quarter-finalist', verified: true,
    description: 'Played centre midfield, one assist in the group stage.' },
  { tournamentName: 'Deccan Table Tennis League', sport: 'Table tennis', location: 'Deccan', eventDate: '2026-03-14', result: 'Semi-finalist', verified: true },
  { tournamentName: 'Republic Day 10K Run', sport: 'Running', location: 'Pune', eventDate: '2026-01-26', result: 'Finisher', verified: false,
    description: 'Finished in 52:40, a personal best.' },
  { tournamentName: 'Kothrud Inter-Society Cup', sport: 'Football', location: 'Kothrud', eventDate: '2025-11-19', result: 'Winner', verified: true },
  { tournamentName: 'Mumbai Carrom Masters', sport: 'Carrom', location: 'Mumbai', eventDate: '2025-09-06', verified: false },
  { tournamentName: 'Sinhgad Cricket Night Series', sport: 'Cricket', location: 'Pune', eventDate: '2025-06-21', result: 'Player of the series', verified: true,
    description: '212 runs and 7 wickets across the series.' },
  { tournamentName: 'Nashik Open Chess Rapid', sport: 'Chess', location: 'Nashik', eventDate: '2024-12-08', result: '3rd place', verified: false },
  { tournamentName: 'College Sports Fest', sport: 'Badminton', location: 'Pune', eventDate: '2024-04-13', result: 'Winner', verified: false,
    description: 'Inter-department singles title.' },
  { tournamentName: 'School Alumni Cricket Match', sport: 'Cricket', location: 'Satara', eventDate: '2022-02-05', verified: false,
    description: 'Annual alumni game, captained the 2015 batch.' },
];

async function main() {
  const arg = process.argv[2];
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);

  if (arg === '--remove') {
    if (!fs.existsSync(IDS_FILE)) {
      console.log('Nothing to remove: no ids file.');
      return;
    }
    const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')).ids;
    const res = await PlayerHistory.deleteMany({ _id: { $in: ids } });
    fs.unlinkSync(IDS_FILE);
    console.log(`Removed ${res.deletedCount} of ${ids.length} demo entries.`);
    return;
  }

  if (!arg || !mongoose.Types.ObjectId.isValid(arg)) throw new Error('Usage: seedDemoHistory.js <userId> | --remove');
  if (fs.existsSync(IDS_FILE)) throw new Error('Demo entries already seeded. Run with --remove first.');

  const user = await User.findById(arg).select('name role').lean();
  if (!user) throw new Error(`No user ${arg}`);
  const before = await PlayerHistory.countDocuments({ user: arg });

  const docs = await PlayerHistory.insertMany(
    DEMO.map((d) => ({
      user: arg,
      status: 'active',
      source: 'profile',
      images: [],
      ...d,
      eventDate: new Date(`${d.eventDate}T10:00:00.000Z`),
    }))
  );
  fs.writeFileSync(IDS_FILE, JSON.stringify({ user: arg, ids: docs.map((d) => String(d._id)) }, null, 2));
  console.log(`Seeded ${docs.length} entries for ${user.name} (${user.role}). They already had ${before}.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

"use strict";
/**
 * Player history timeline.
 *
 * What these tests pin:
 *   • a post by a player writes that player's own timeline entry (active) —
 *     the post and the history are two records, not one;
 *   • a tagged player gets a PENDING entry that is invisible until approved,
 *     and a rejected one never appears;
 *   • deleting the post leaves every history entry in place;
 *   • `verified` is computed from bookings (registrant OR roster member of a
 *     non-cancelled booking) and can never be asserted by the client;
 *   • only the entry's owner can edit / delete / approve / reject it;
 *   • posts and manual entries accept images.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
// uploads.js reads UPLOADS_DIR at load time — point it away from the repo
// before anything pulls the app in.
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "history-uploads-"));

const request = require("supertest");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { startTxApp, stopTxApp, clearDatabase } = require("./setupReplset");

const Tournament = require("../../src/modules/tournaments/models/Tournament");
const Sport = require("../../src/modules/catalog/models/Sport");
const Booking = require("../../src/modules/tournaments/models/BookingModel");
const User = require("../../src/modules/identity/models/User");
const Post = require("../../src/modules/social/models/Post");
const PlayerHistory = require("../../src/modules/social/models/PlayerHistory");
const { Manager } = require("../../src/modules/identity/models/ClubManager");

let app;

beforeAll(async () => {
  app = await startTxApp();
});
afterAll(async () => {
  await stopTxApp();
  fs.rmSync(process.env.UPLOADS_DIR, { recursive: true, force: true });
});
beforeEach(clearDatabase);

const token = (id, role = "Player") =>
  jwt.sign({ id: String(id), role }, process.env.JWT_SECRET, { expiresIn: "1h" });

let seq = 0;
async function makePlayer(name) {
  seq += 1;
  return User.create({
    name,
    email: `${name.replace(/\s/g, "").toLowerCase()}${seq}@test.local`,
    password: "x",
    role: "Player",
    dateOfBirth: new Date("1995-01-01"),
    sex: "male",
    mobile: `97000000${String(seq).padStart(2, "0")}`,
  });
}

async function makeTournament(title = "City Open") {
  const sport = await Sport.create({ name: "Table Tennis", category: "Racquet", scoringType: "sets" });
  return Tournament.create({
    title,
    startDate: new Date("2030-03-01"),
    endDate: new Date("2030-03-02"),
    clubId: new mongoose.Types.ObjectId(),
    sports: [
      {
        sportId: sport._id,
        sportName: "Table Tennis",
        tournamentLevel: "unranked",
        categories: [{ name: "Singles", fee: 100 }],
      },
    ],
  });
}

function book(user, tournament, extra = {}) {
  return Booking.create({
    userId: user ? user._id : null,
    userName: user ? user.name : "Guest",
    tournamentId: tournament._id,
    tournamentName: tournament.title,
    tournamentType: "knockout",
    clubId: tournament.clubId,
    ...extra,
  });
}

const createPost = (user, body) =>
  request(app).post("/api/posts").set("Authorization", `Bearer ${token(user._id)}`).send(body);

const timeline = (viewer, ownerId) =>
  request(app)
    .get(`/api/player-history/user/${ownerId}`)
    .set("Authorization", `Bearer ${token(viewer._id)}`);

const pending = (user) =>
  request(app).get("/api/player-history/pending").set("Authorization", `Bearer ${token(user._id)}`);

// 1×1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

describe("post → author timeline", () => {
  test("a player's post writes an ACTIVE, verified entry when they are registered", async () => {
    const me = await makePlayer("Asha Rao");
    const t = await makeTournament();
    await book(me, t);

    const res = await createPost(me, {
      tournamentName: "city open",
      caption: "Won the final 3-1",
      location: "Pune",
      eventDate: "2030-03-02",
    });
    expect(res.status).toBe(201);

    const tl = await timeline(me, me._id);
    expect(tl.body.entries).toHaveLength(1);
    const e = tl.body.entries[0];
    expect(e).toMatchObject({
      tournamentName: "City Open",
      description: "Won the final 3-1",
      location: "Pune",
      sport: "Table Tennis",
      source: "post",
      status: "active",
      verified: true,
      postId: String(res.body._id),
    });
    expect(new Date(e.eventDate).toISOString().slice(0, 10)).toBe("2030-03-02");
  });

  test("not verified when the player never registered for that tournament", async () => {
    const me = await makePlayer("Spectator Sam");
    await makeTournament();
    await createPost(me, { tournamentName: "City Open", caption: "Great matches" });
    const tl = await timeline(me, me._id);
    expect(tl.body.entries[0].verified).toBe(false);
  });

  test("a CANCELLED booking does not verify", async () => {
    const me = await makePlayer("Cancelled Chris");
    const t = await makeTournament();
    await book(me, t, { status: "cancelled" });
    await createPost(me, { tournamentName: "City Open", caption: "Pulled out" });
    const tl = await timeline(me, me._id);
    expect(tl.body.entries[0].verified).toBe(false);
  });

  test("being on someone else's team roster counts as registered", async () => {
    const captain = await makePlayer("Captain Kim");
    const mate = await makePlayer("Mate Mo");
    const t = await makeTournament();
    await book(captain, t, {
      team: { name: "Smashers", roster: [{ userId: String(mate._id), name: mate.name, role: "player" }] },
    });
    await createPost(mate, { tournamentName: "City Open", caption: "Team event" });
    const tl = await timeline(mate, mate._id);
    expect(tl.body.entries[0].verified).toBe(true);
  });

  test("a post for an unknown tournament is rejected and writes no history", async () => {
    const me = await makePlayer("Nobody Nate");
    const res = await createPost(me, { tournamentName: "Ghost Cup", caption: "?" });
    expect(res.status).toBe(400);
    expect(await PlayerHistory.countDocuments()).toBe(0);
  });
});

describe("tagging requires approval", () => {
  test("tagged player gets a pending entry, hidden until approved", async () => {
    const author = await makePlayer("Author Ann");
    const friend = await makePlayer("Friend Fay");
    const t = await makeTournament();
    await book(friend, t);

    const res = await createPost(author, {
      tournamentName: "City Open",
      caption: "Played with Fay",
      taggedUserIds: [String(friend._id)],
    });
    expect(res.status).toBe(201);

    // Not on the timeline yet…
    expect((await timeline(friend, friend._id)).body.entries).toHaveLength(0);
    // …but waiting in the inbox, with who tagged them.
    const inbox = (await pending(friend)).body.entries;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ status: "pending", source: "tagged", verified: true });
    expect(inbox[0].taggedBy.name).toBe("Author Ann");

    const ok = await request(app)
      .post(`/api/player-history/${inbox[0].id}/approve`)
      .set("Authorization", `Bearer ${token(friend._id)}`);
    expect(ok.status).toBe(200);

    expect((await timeline(friend, friend._id)).body.entries).toHaveLength(1);
    expect((await pending(friend)).body.entries).toHaveLength(0);
  });

  test("a rejected entry never appears and cannot be re-decided", async () => {
    const author = await makePlayer("Author Ann");
    const friend = await makePlayer("Friend Fay");
    await makeTournament();
    await createPost(author, {
      tournamentName: "City Open",
      caption: "x",
      taggedUserIds: [String(friend._id)],
    });
    const [e] = (await pending(friend)).body.entries;

    const no = await request(app)
      .post(`/api/player-history/${e.id}/reject`)
      .set("Authorization", `Bearer ${token(friend._id)}`);
    expect(no.status).toBe(200);
    expect((await timeline(friend, friend._id)).body.entries).toHaveLength(0);

    const again = await request(app)
      .post(`/api/player-history/${e.id}/approve`)
      .set("Authorization", `Bearer ${token(friend._id)}`);
    expect(again.status).toBe(409);
  });

  test("only the tagged player can decide; the author cannot approve for them", async () => {
    const author = await makePlayer("Author Ann");
    const friend = await makePlayer("Friend Fay");
    await makeTournament();
    await createPost(author, {
      tournamentName: "City Open",
      caption: "x",
      taggedUserIds: [String(friend._id)],
    });
    const [e] = (await pending(friend)).body.entries;
    const res = await request(app)
      .post(`/api/player-history/${e.id}/approve`)
      .set("Authorization", `Bearer ${token(author._id)}`);
    expect(res.status).toBe(404);
    expect((await PlayerHistory.findById(e.id)).status).toBe("pending");
  });

  test("self-tags, duplicates and unknown ids are ignored", async () => {
    const author = await makePlayer("Author Ann");
    const friend = await makePlayer("Friend Fay");
    await makeTournament();
    const res = await createPost(author, {
      tournamentName: "City Open",
      caption: "x",
      taggedUserIds: [
        String(author._id),
        String(friend._id),
        String(friend._id),
        String(new mongoose.Types.ObjectId()),
        "not-an-id",
      ],
    });
    expect(res.status).toBe(201);
    expect(await PlayerHistory.countDocuments({ status: "pending" })).toBe(1);
    expect(await PlayerHistory.countDocuments({ user: author._id })).toBe(1); // only the author's own, active
  });

  test("a Manager's post has no timeline of its own but still prompts tagged players", async () => {
    const friend = await makePlayer("Friend Fay");
    const t = await makeTournament();
    // Managers are tenant-scoped: they only see their own club's tournaments.
    const manager = await Manager.create({
      name: "Desk Manager",
      email: "mgr@test.local",
      password: "x",
      mobile: "9800000000",
      clubId: t.clubId,
    });
    const res = await request(app)
      .post("/api/posts")
      .set("Authorization", `Bearer ${token(manager._id, "Manager")}`)
      .send({ tournamentName: "City Open", caption: "Event recap", taggedUserIds: [String(friend._id)] });
    expect(res.status).toBe(201);
    expect(await PlayerHistory.countDocuments({ status: "active" })).toBe(0);
    const [e] = (await pending(friend)).body.entries;
    expect(e.taggedBy).toBeNull();
  });
});

describe("tag notifications", () => {
  const PlayerNotification = require("../../src/modules/social/models/PlayerNotification");

  test("each tagged player is notified once; the author is not", async () => {
    const author = await makePlayer("Author Ann");
    const f1 = await makePlayer("Friend Fay");
    const f2 = await makePlayer("Friend Finn");
    await makeTournament();
    await createPost(author, {
      tournamentName: "City Open",
      caption: "Doubles day",
      taggedUserIds: [String(f1._id), String(f2._id)],
    });

    const notes = await PlayerNotification.find({ type: "history_tag" });
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => String(n.userId)).sort()).toEqual([String(f1._id), String(f2._id)].sort());
    expect(await PlayerNotification.countDocuments({ userId: author._id })).toBe(0);

    const n = notes.find((x) => String(x.userId) === String(f1._id));
    expect(n.message).toContain("Author Ann");
    expect(n.message).toContain("City Open");
    // Deep-link data points at the pending entry that was created for them.
    const [entry] = (await pending(f1)).body.entries;
    expect(n.data.historyId).toBe(entry.id);
  });

  test("a post with nobody tagged sends no notification", async () => {
    const author = await makePlayer("Author Ann");
    await makeTournament();
    await createPost(author, { tournamentName: "City Open", caption: "Solo" });
    expect(await PlayerNotification.countDocuments()).toBe(0);
  });

  test("a failing notification does not fail the post or lose the entry", async () => {
    const author = await makePlayer("Author Ann");
    const friend = await makePlayer("Friend Fay");
    await makeTournament();
    const spy = jest.spyOn(PlayerNotification, "create").mockRejectedValue(new Error("db down"));
    const res = await createPost(author, {
      tournamentName: "City Open",
      caption: "x",
      taggedUserIds: [String(friend._id)],
    });
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect((await pending(friend)).body.entries).toHaveLength(1);
  });
});

describe("teammates on the timeline", () => {
  test("only players with an active entry for the same post are listed", async () => {
    const author = await makePlayer("Author Ann");
    const fay = await makePlayer("Friend Fay");
    const gus = await makePlayer("Friend Gus");
    await makeTournament();
    await createPost(author, {
      tournamentName: "City Open",
      caption: "Doubles day",
      taggedUserIds: [String(fay._id), String(gus._id)],
    });

    // Fay approves; Gus leaves the tag pending.
    const [fayEntry] = (await pending(fay)).body.entries;
    await request(app)
      .post(`/api/player-history/${fayEntry.id}/approve`)
      .set("Authorization", `Bearer ${token(fay._id)}`);

    const authorView = (await timeline(author, author._id)).body.entries;
    expect(authorView).toHaveLength(1);
    expect(authorView[0].teammates.map((m) => m.name)).toEqual(["Friend Fay"]);

    const fayView = (await timeline(fay, fay._id)).body.entries;
    expect(fayView[0].teammates.map((m) => m.name)).toEqual(["Author Ann"]);
    expect(fayView[0].teammates[0]).toHaveProperty("id");
    expect(fayView[0].teammates[0]).toHaveProperty("avatar");
  });

  test("manual entries have no teammates", async () => {
    const p = await makePlayer("Solo Sam");
    await request(app)
      .post("/api/player-history")
      .set("Authorization", `Bearer ${token(p._id)}`)
      .field("tournamentName", "Local Cup");
    const entries = (await timeline(p, p._id)).body.entries;
    expect(entries[0].teammates).toEqual([]);
  });
});

describe("deleting a post keeps the history", () => {
  test("author's and approved tagged entries survive the post being deleted", async () => {
    const author = await makePlayer("Author Ann");
    const friend = await makePlayer("Friend Fay");
    await makeTournament();
    const post = await createPost(author, {
      tournamentName: "City Open",
      caption: "Final day",
      taggedUserIds: [String(friend._id)],
    });
    const [e] = (await pending(friend)).body.entries;
    await request(app)
      .post(`/api/player-history/${e.id}/approve`)
      .set("Authorization", `Bearer ${token(friend._id)}`);

    // Only the author may delete the post.
    const stranger = await request(app)
      .delete(`/api/posts/${post.body._id}`)
      .set("Authorization", `Bearer ${token(friend._id)}`);
    expect(stranger.status).toBe(403);

    const del = await request(app)
      .delete(`/api/posts/${post.body._id}`)
      .set("Authorization", `Bearer ${token(author._id)}`);
    expect(del.status).toBe(200);
    expect(await Post.findById(post.body._id)).toBeNull();

    expect((await timeline(author, author._id)).body.entries).toHaveLength(1);
    expect((await timeline(friend, friend._id)).body.entries).toHaveLength(1);
  });
});

describe("manual entries (sign-up / profile)", () => {
  const create = (user, fields, attach) => {
    let r = request(app).post("/api/player-history").set("Authorization", `Bearer ${token(user._id)}`);
    Object.entries(fields).forEach(([k, v]) => (r = r.field(k, v)));
    if (attach) r = r.attach("historyImages", PNG, { filename: "a.png", contentType: "image/png" });
    return r;
  };

  test("an unknown tournament is self-reported (unverified, unlinked)", async () => {
    const me = await makePlayer("Asha Rao");
    const res = await create(me, {
      tournamentName: "Society League 2019",
      sport: "Cricket",
      eventDate: "2019-05-10",
      result: "Runner-up",
      source: "signup",
    });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({
      verified: false,
      tournamentId: null,
      source: "signup",
      result: "Runner-up",
      sport: "Cricket",
    });
  });

  test("the client cannot assert `verified` or a tournament link", async () => {
    const me = await makePlayer("Asha Rao");
    const t = await makeTournament();
    const res = await create(me, {
      tournamentName: "Made Up Cup",
      verified: "true",
      tournamentId: String(t._id),
    });
    expect(res.body.entry.verified).toBe(false);
    expect(res.body.entry.tournamentId).toBeNull();
  });

  test("a real tournament the player is registered for is verified", async () => {
    const me = await makePlayer("Asha Rao");
    const t = await makeTournament();
    await book(me, t);
    const res = await create(me, { tournamentName: "City Open" });
    expect(res.body.entry).toMatchObject({ verified: true, tournamentId: String(t._id), sport: "Table Tennis" });
  });

  test("images upload and are stored as relative paths", async () => {
    const me = await makePlayer("Asha Rao");
    const res = await create(me, { tournamentName: "Society League" }, true);
    expect(res.status).toBe(201);
    expect(res.body.entry.images).toHaveLength(1);
    expect(res.body.entry.images[0]).toMatch(/^history\/historyImages-.+\.png$/);
    expect(fs.existsSync(path.join(process.env.UPLOADS_DIR, res.body.entry.images[0]))).toBe(true);
  });

  test("tournament name and bad dates are validated", async () => {
    const me = await makePlayer("Asha Rao");
    expect((await create(me, { sport: "Cricket" })).status).toBe(400);
    expect((await create(me, { tournamentName: "X", eventDate: "not-a-date" })).status).toBe(400);
  });

  test("owner can edit and delete; others cannot", async () => {
    const me = await makePlayer("Asha Rao");
    const other = await makePlayer("Other Olly");
    const { body } = await create(me, { tournamentName: "Society League", result: "Semi-final" });
    const id = body.entry.id;

    const stranger = await request(app)
      .patch(`/api/player-history/${id}`)
      .set("Authorization", `Bearer ${token(other._id)}`)
      .send({ result: "Winner" });
    expect(stranger.status).toBe(404);

    const edited = await request(app)
      .patch(`/api/player-history/${id}`)
      .set("Authorization", `Bearer ${token(me._id)}`)
      .send({ result: "Winner", verified: true });
    expect(edited.status).toBe(200);
    expect(edited.body.entry.result).toBe("Winner");
    expect(edited.body.entry.verified).toBe(false); // not editable

    const strangerDel = await request(app)
      .delete(`/api/player-history/${id}`)
      .set("Authorization", `Bearer ${token(other._id)}`);
    expect(strangerDel.status).toBe(404);

    const del = await request(app)
      .delete(`/api/player-history/${id}`)
      .set("Authorization", `Bearer ${token(me._id)}`);
    expect(del.status).toBe(200);
    expect(await PlayerHistory.countDocuments()).toBe(0);
  });
});

describe("post images", () => {
  test("a multipart post stores images on the post and copies them to the timeline", async () => {
    const me = await makePlayer("Asha Rao");
    await makeTournament();
    const res = await request(app)
      .post("/api/posts")
      .set("Authorization", `Bearer ${token(me._id)}`)
      .field("tournamentName", "City Open")
      .field("caption", "Trophy shot")
      .attach("postImages", PNG, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(res.body.images).toHaveLength(1);
    expect(res.body.images[0]).toMatch(/^posts\/postImages-.+\.png$/);

    const e = (await timeline(me, me._id)).body.entries[0];
    expect(e.images).toEqual(res.body.images);
  });

  test("a non-image upload is refused", async () => {
    const me = await makePlayer("Asha Rao");
    await makeTournament();
    const res = await request(app)
      .post("/api/posts")
      .set("Authorization", `Bearer ${token(me._id)}`)
      .field("tournamentName", "City Open")
      .field("caption", "x")
      .attach("postImages", Buffer.from("<script>1</script>"), { filename: "x.html", contentType: "text/html" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await Post.countDocuments()).toBe(0);
  });
});

describe("timeline visibility", () => {
  const setVisibility = (user, visibility) =>
    request(app)
      .put("/api/player-history/settings")
      .set("Authorization", `Bearer ${token(user._id)}`)
      .send({ visibility });

  async function ownerWithEntry() {
    const owner = await makePlayer("Owner Omar");
    await PlayerHistory.create({ user: owner._id, tournamentName: "Secret Cup", source: "profile" });
    return owner;
  }

  test("public by default — anyone logged in can read it", async () => {
    const owner = await ownerWithEntry();
    const viewer = await makePlayer("Viewer Vik");
    const res = await timeline(viewer, owner._id);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.restricted).toBeUndefined();
    const s = await request(app)
      .get("/api/player-history/settings")
      .set("Authorization", `Bearer ${token(owner._id)}`);
    expect(s.body.visibility).toBe("public");
  });

  test("private hides it from everyone but the owner and a SuperAdmin", async () => {
    const owner = await ownerWithEntry();
    const viewer = await makePlayer("Viewer Vik");
    expect((await setVisibility(owner, "private")).status).toBe(200);

    const seen = await timeline(viewer, owner._id);
    expect(seen.status).toBe(200);
    expect(seen.body.entries).toEqual([]);
    expect(seen.body.restricted).toBe("private");

    expect((await timeline(owner, owner._id)).body.entries).toHaveLength(1);

    const admin = await request(app)
      .get(`/api/player-history/user/${owner._id}`)
      .set(
        "Authorization",
        `Bearer ${jwt.sign(
          { email: "qa@test.local", role: "superadmin", userId: new mongoose.Types.ObjectId() },
          process.env.JWT_SECRET,
          { expiresIn: "1h" }
        )}`
      );
    expect(admin.body.entries).toHaveLength(1);
  });

  test("followers-only lets followers in and keeps others out", async () => {
    const owner = await ownerWithEntry();
    const follower = await makePlayer("Follower Fia");
    const stranger = await makePlayer("Stranger Stu");
    await User.updateOne({ _id: follower._id }, { $push: { following: owner._id } });
    await setVisibility(owner, "followers");

    expect((await timeline(follower, owner._id)).body.entries).toHaveLength(1);
    const blocked = await timeline(stranger, owner._id);
    expect(blocked.body.entries).toEqual([]);
    expect(blocked.body.restricted).toBe("followers");
  });

  test("the owner can switch it back, and bad values are rejected", async () => {
    const owner = await ownerWithEntry();
    const viewer = await makePlayer("Viewer Vik");
    await setVisibility(owner, "private");
    await setVisibility(owner, "public");
    expect((await timeline(viewer, owner._id)).body.entries).toHaveLength(1);

    const bad = await setVisibility(owner, "friends-of-friends");
    expect(bad.status).toBe(400);
    expect((await User.findById(owner._id)).historyVisibility).toBe("public");
  });

  test("a stranger cannot change someone else's setting (it always applies to the caller)", async () => {
    const owner = await ownerWithEntry();
    const other = await makePlayer("Other Olly");
    await request(app)
      .put("/api/player-history/settings")
      .set("Authorization", `Bearer ${token(other._id)}`)
      .send({ visibility: "private", userId: String(owner._id) });
    expect((await User.findById(owner._id)).historyVisibility).toBe("public");
    expect((await User.findById(other._id)).historyVisibility).toBe("private");
  });
});

describe("legacy achievements migration", () => {
  test("free-text achievements become self-reported entries, exactly once", async () => {
    const me = await makePlayer("Asha Rao");
    await User.updateOne(
      { _id: me._id },
      { $set: { achievements: "District TT champion 2022\n\nState finalist\n  Best sportsperson  " } }
    );

    const first = await timeline(me, me._id);
    expect(first.body.entries.map((e) => e.tournamentName).sort()).toEqual([
      "Best sportsperson",
      "District TT champion 2022",
      "State finalist",
    ]);
    expect(first.body.entries.every((e) => e.verified === false && e.source === "profile")).toBe(true);

    // Reading again — by the owner or anyone else — must not duplicate them.
    const other = await makePlayer("Other Olly");
    await timeline(other, me._id);
    expect(await PlayerHistory.countDocuments({ user: me._id })).toBe(3);

    // The original text is kept as a backup.
    expect((await User.findById(me._id)).achievements).toContain("District TT champion 2022");
  });

  test("entries the player deletes after migration do not come back", async () => {
    const me = await makePlayer("Asha Rao");
    await User.updateOne({ _id: me._id }, { $set: { achievements: "Only one" } });
    const [e] = (await timeline(me, me._id)).body.entries;
    await request(app)
      .delete(`/api/player-history/${e.id}`)
      .set("Authorization", `Bearer ${token(me._id)}`);
    expect((await timeline(me, me._id)).body.entries).toHaveLength(0);
  });

  test("a player with no legacy text migrates to nothing", async () => {
    const me = await makePlayer("Asha Rao");
    expect((await timeline(me, me._id)).body.entries).toHaveLength(0);
    expect((await User.findById(me._id)).achievementsMigratedAt).toBeInstanceOf(Date);
  });
});

describe("timeline ordering", () => {
  test("newest event first, by event date rather than when it was added", async () => {
    const me = await makePlayer("Asha Rao");
    const add = (name, eventDate) =>
      request(app)
        .post("/api/player-history")
        .set("Authorization", `Bearer ${token(me._id)}`)
        .send({ tournamentName: name, eventDate });
    await add("Old", "2018-01-01");
    await add("New", "2024-06-01");
    await add("Middle", "2021-03-01");
    const names = (await timeline(me, me._id)).body.entries.map((e) => e.tournamentName);
    expect(names).toEqual(["New", "Middle", "Old"]);
  });
});

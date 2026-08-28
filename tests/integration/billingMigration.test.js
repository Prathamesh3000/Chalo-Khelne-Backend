"use strict";
/**
 * Phase 3 checkpoint — trimming the base role without breaking live customers.
 *
 * This is the migration that makes the paywall real, and it is the one with
 * the largest blast radius in the whole module: it rewrites the role every
 * club on the platform resolves through.
 *
 * The test that matters most is the last one — after grandfathering, an
 * EXISTING club must still be able to do everything it could yesterday, now
 * via a comped subscription instead of via the role. If that fails, deploy day
 * strips features from every paying customer at once.
 */
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { startTestApp, stopTestApp, clearDatabase } = require("./setup");
const { authenticate } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/rbacMiddleware");

const migrate = require("../../scripts/migrateBillingBaseline");
const { FREE_TIER, PRE_TRIM_CLUB_ADMIN, GRANDFATHERED, COMPED_SLUG } = migrate;

const Role = require("../../src/modules/identity/models/Role");
const Permission = require("../../src/modules/identity/models/Permission");
const User = require("../../src/modules/identity/models/User");
const Subscription = require("../../src/modules/billing/models/Subscription");

let uniq = 0;
let probe;

beforeAll(async () => {
  await startTestApp();
  probe = express();
  // "Verify payments" — one of the 22 that move behind a plan.
  probe.get("/paid", authenticate, requirePermission("payment:approve"), (_req, res) =>
    res.json({ ok: true })
  );
});
afterAll(stopTestApp);

beforeEach(async () => {
  await clearDatabase();
  await seedPreTrimState();
});

/** The world as it stands BEFORE the migration: club_admin holds all 31. */
async function seedPreTrimState() {
  const ids = [];
  for (const key of PRE_TRIM_CLUB_ADMIN) {
    const [module_, action] = key.split(":");
    const p = await Permission.create({ key, name: key, module: module_, action });
    ids.push(p._id);
  }
  await Role.create({
    name: "Club Admin", slug: "club_admin", authorityLevel: 1, permissions: ids,
  });
}

async function makeClub() {
  uniq += 1;
  return User.create({
    name: `Club ${uniq}`, email: `mig-${uniq}-${Date.now()}@test.local`,
    password: "x", role: "ClubAdmin",
    dateOfBirth: new Date("1990-01-01"), sex: "male", mobile: "9999999999",
  });
}

const tokenFor = (u) =>
  jwt.sign({ id: String(u._id), role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

const roleKeys = async () => {
  const r = await Role.findOne({ slug: "club_admin" }).populate("permissions");
  return (r.permissions || []).map((p) => p.key).sort();
};

const opts = (over = {}) => ({ mode: "grandfather", apply: true, rollback: false, days: 365, ...over });

// ═══════════════════════════════════════════════════════════════
// Dry run
// ═══════════════════════════════════════════════════════════════

describe("dry run", () => {
  test("writes nothing at all", async () => {
    await makeClub();
    await migrate(opts({ apply: false }));

    expect(await roleKeys()).toHaveLength(31);
    expect(await Subscription.countDocuments({})).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// grandfather
// ═══════════════════════════════════════════════════════════════

describe("--mode=grandfather", () => {
  test("trims the role and comps every existing club", async () => {
    const a = await makeClub();
    const b = await makeClub();

    await migrate(opts());

    expect(await roleKeys()).toEqual([...FREE_TIER].sort());

    for (const club of [a, b]) {
      const sub = await Subscription.findOne({ subjectId: club._id });
      expect(sub).toBeTruthy();
      expect(sub.isComped).toBe(true);
      expect(sub.planSlug).toBe(COMPED_SLUG);
      expect(sub.pricePaidRupees).toBe(0);
      expect([...sub.grantedPermissions].sort()).toEqual([...GRANDFATHERED].sort());
    }
  });

  test("the comped grant plus the base role reconstitutes the original 31", async () => {
    const club = await makeClub();
    await migrate(opts());

    const sub = await Subscription.findOne({ subjectId: club._id });
    const effective = new Set([...(await roleKeys()), ...sub.grantedPermissions]);

    expect(effective.size).toBe(PRE_TRIM_CLUB_ADMIN.length);
    for (const key of PRE_TRIM_CLUB_ADMIN) expect(effective.has(key)).toBe(true);
  });

  test("is idempotent — a second run issues no duplicates", async () => {
    await makeClub();
    await migrate(opts());
    await migrate(opts());

    expect(await Subscription.countDocuments({})).toBe(1);
    expect(await roleKeys()).toEqual([...FREE_TIER].sort());
  });

  test("never overwrites a club that already bought a real plan", async () => {
    const club = await makeClub();
    await Subscription.create({
      subjectId: club._id, subjectType: "club", planSlug: "pro",
      grantedPermissions: ["payment:read"], pricePaidRupees: 300,
      status: "active", startsAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 864e5),
    });

    await migrate(opts());

    const subs = await Subscription.find({ subjectId: club._id });
    expect(subs).toHaveLength(1);
    expect(subs[0].planSlug).toBe("pro"); // their purchase is untouched
  });

  test("respects --days", async () => {
    const club = await makeClub();
    await migrate(opts({ days: 30 }));

    const sub = await Subscription.findOne({ subjectId: club._id });
    const days = Math.round((sub.expiresAt - sub.startsAt) / 864e5);
    expect(days).toBe(30);
  });
});

// ═══════════════════════════════════════════════════════════════
// cut
// ═══════════════════════════════════════════════════════════════

describe("--mode=cut", () => {
  test("trims the role and issues nothing", async () => {
    await makeClub();
    await migrate(opts({ mode: "cut" }));

    expect(await roleKeys()).toEqual([...FREE_TIER].sort());
    expect(await Subscription.countDocuments({})).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// rollback
// ═══════════════════════════════════════════════════════════════

describe("--rollback", () => {
  test("restores the pre-trim role and removes only comped rows", async () => {
    const club = await makeClub();
    // A real purchase that rollback must NOT touch.
    await Subscription.create({
      subjectId: (await makeClub())._id, subjectType: "club", planSlug: "pro",
      grantedPermissions: [], pricePaidRupees: 300, status: "active",
      startsAt: new Date(), expiresAt: new Date(Date.now() + 30 * 864e5),
    });

    await migrate(opts());
    expect(await Subscription.countDocuments({ planSlug: COMPED_SLUG })).toBe(1);

    await migrate(opts({ rollback: true }));

    expect(await roleKeys()).toEqual([...PRE_TRIM_CLUB_ADMIN].sort());
    expect(await Subscription.countDocuments({ planSlug: COMPED_SLUG })).toBe(0);
    expect(await Subscription.countDocuments({ planSlug: "pro" })).toBe(1);
    expect(club).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// Safety
// ═══════════════════════════════════════════════════════════════

describe("safety", () => {
  test("refuses to trim against an incomplete permission catalogue", async () => {
    // Deleting a free-tier permission means trimming would silently drop it
    // from the role and lock every club out of a core feature.
    await Permission.deleteOne({ key: "tournament:score" });

    await expect(migrate(opts())).rejects.toThrow(/missing/i);

    // Assert on the RAW permission array, not the populated one: deleting a
    // Permission document naturally drops it from a populate(), so roleKeys()
    // would read 30 whether or not the role itself was rewritten. The raw
    // length is what actually proves the migration left the role alone.
    const raw = await Role.findOne({ slug: "club_admin" }).lean();
    expect(raw.permissions).toHaveLength(31);
    expect(await Subscription.countDocuments({})).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// THE test — grandfathering actually preserves access
// ═══════════════════════════════════════════════════════════════

describe("an existing club keeps working across the migration", () => {
  test("payment:approve works before, and STILL works after grandfathering", async () => {
    const club = await makeClub();
    const token = tokenFor(club);
    const call = () => request(probe).get("/paid").set("Authorization", `Bearer ${token}`);

    // Yesterday: allowed by the role.
    expect((await call()).status).toBe(200);

    await migrate(opts());

    // Today: the role no longer grants it...
    expect(await roleKeys()).not.toContain("payment:approve");
    // ...but the comped subscription does, so nothing broke for the customer.
    expect((await call()).status).toBe(200);
  });

  test("under --mode=cut the same club loses it — the contrast that proves the point", async () => {
    const club = await makeClub();
    const token = tokenFor(club);
    const call = () => request(probe).get("/paid").set("Authorization", `Bearer ${token}`);

    expect((await call()).status).toBe(200);

    await migrate(opts({ mode: "cut" }));

    // This is what "cut clean" costs, made concrete.
    expect((await call()).status).toBe(403);
  });

  test("a NEW club after the migration gets only the free tier", async () => {
    await migrate(opts());

    const fresh = await makeClub(); // created after the trim, no comped grant
    const res = await request(probe)
      .get("/paid")
      .set("Authorization", `Bearer ${tokenFor(fresh)}`);

    expect(res.status).toBe(403); // must buy — the paywall is real
  });
});

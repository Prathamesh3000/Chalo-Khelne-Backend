"use strict";
/**
 * The 3-player team tie must follow the ITTF (Swaythling Cup) rubber order.
 *
 * Source of truth: the GG International School inter-school table tennis score
 * sheet (U-11 Boys, 2026-27) — the format every school tie in India is run on:
 *
 *     1. A v X      2. B v Y      3. C v Z      4. A v Y      5. B v X
 *
 * The property that makes it correct is SYMMETRY: each side uses its three
 * players 2-2-1. `singles_3p_bo5` originally ended "B v Z", which left the
 * away side playing X once and Z twice while the home side played A twice and
 * C once — a lopsided draw where one team's first player sits out the decider
 * position and the other's third player is overworked.
 */
const {
  getFormat,
  TEAM_KNOCKOUT_FORMATS,
} = require("../../Config/teamKnockoutFormats");

/** Away roster slots are stored A/B/C and displayed X/Y/Z. */
const XYZ = { A: "X", B: "Y", C: "Z" };
const rubber = (s) =>
  `${s.homePos.join("+")}-${s.awayPos.map((p) => XYZ[p]).join("+")}`;

describe("singles_3p_bo5 — ITTF Swaythling order", () => {
  const fmt = getFormat("singles_3p_bo5");

  test("the format exists and is a 3-player, best-of-5 tie", () => {
    expect(fmt).toBeTruthy();
    expect(fmt.totalSets).toBe(5);
    expect(fmt.setsToWin).toBe(3);
    expect(fmt.minPlayers).toBe(3);
    expect(fmt.hasDoubles).toBe(false);
  });

  test("rubbers run A-X, B-Y, C-Z, A-Y, B-X", () => {
    expect(fmt.sets.map(rubber)).toEqual([
      "A-X",
      "B-Y",
      "C-Z",
      "A-Y",
      "B-X",
    ]);
  });

  test("the C v Z rubber is present — the third player actually plays", () => {
    const cz = fmt.sets.find((s) => rubber(s) === "C-Z");
    expect(cz).toBeTruthy();
    expect(cz.setNumber).toBe(3);
  });

  test("both sides use their players 2-2-1 — the draw is symmetric", () => {
    const count = (pick) => {
      const n = { A: 0, B: 0, C: 0 };
      for (const s of fmt.sets) for (const p of pick(s)) n[p] += 1;
      return n;
    };
    const home = count((s) => s.homePos);
    const away = count((s) => s.awayPos);

    expect(home).toEqual({ A: 2, B: 2, C: 1 });
    expect(away).toEqual({ A: 2, B: 2, C: 1 });
    // Stated as a property too, so a future reorder that stays symmetric but
    // changes the sequence still has to be deliberate about this.
    expect(away).toEqual(home);
  });
});

describe("singles_3p_bo3 — the short tie", () => {
  const fmt = getFormat("singles_3p_bo3");

  test("runs A-X, B-Y, C-Z with every player used once", () => {
    expect(fmt.sets.map(rubber)).toEqual(["A-X", "B-Y", "C-Z"]);
    expect(fmt.minPlayers).toBe(3);
  });
});

describe("the 2-player formats are untouched by this fix", () => {
  test("singles_bo5 still never references a C slot", () => {
    const fmt = getFormat("singles_bo5");
    const slots = fmt.sets.flatMap((s) => [...s.homePos, ...s.awayPos]);
    expect(slots).not.toContain("C");
    expect(fmt.minPlayers).toBe(2);
  });

  // NOTE: two slot conventions coexist. The Davis-Cup family uses A/B/C, while
  // the CSL / Rapid Rallies family uses P1..P5 roster slots. This assertion is
  // scoped to the A/B/C family only — a P-slot format legitimately has no "C".
  test("every A/B/C format declaring minPlayers 3 actually uses the C slot", () => {
    const all = Array.isArray(TEAM_KNOCKOUT_FORMATS)
      ? TEAM_KNOCKOUT_FORMATS
      : Object.values(TEAM_KNOCKOUT_FORMATS);

    const slotsOf = (fmt) =>
      fmt.sets.flatMap((s) => [
        ...(s.homePos || s.defaultHomePos || []),
        ...(s.awayPos || s.defaultAwayPos || []),
        ...(s.options || []).flatMap((o) => [...o.homePos, ...o.awayPos]),
      ]);

    const abcFamily = all.filter(
      (f) => f.minPlayers === 3 && slotsOf(f).some((x) => ["A", "B"].includes(x))
    );
    expect(abcFamily.length).toBeGreaterThan(0);

    for (const fmt of abcFamily) {
      const slots = slotsOf(fmt);
      // A 3-player format that never fields its third player is a 2-player
      // format wearing the wrong label.
      expect(slots).toContain("C");
    }
  });
});

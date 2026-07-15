import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, TestD1 } from "./d1-adapter";
import { dayOfWeekAnalysis, timeOfDayAnalysis } from "../src/worker/patterns";
import { chiSquareContingency, rayleighTest } from "../src/shared/stats";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("chiSquareContingency", () => {
  it("finds no association when both rows have the same split", () => {
    const r = chiSquareContingency([
      [50, 50],
      [50, 50],
    ]);
    expect(r.chi2).toBeCloseTo(0, 6);
    expect(r.p).toBeGreaterThan(0.9);
  });

  it("finds a strong association when the split flips", () => {
    const r = chiSquareContingency([
      [90, 10],
      [10, 90],
    ]);
    expect(r.chi2).toBeGreaterThan(50);
    expect(r.p).toBeLessThan(0.001);
  });
});

describe("rayleighTest", () => {
  it("reports near-uniform for evenly spread angles", () => {
    const angles = Array.from({ length: 24 }, (_, i) => (i / 24) * 2 * Math.PI);
    const r = rayleighTest(angles);
    expect(r.resultant).toBeLessThan(0.05);
    expect(r.p).toBeGreaterThan(0.5);
  });

  it("detects a tight cluster around one angle", () => {
    // 40 onsets all near 3π/2 (18:00 on a 24h clock).
    const angles = Array.from({ length: 40 }, () => (3 * Math.PI) / 2 + (Math.PI / 180));
    const r = rayleighTest(angles);
    expect(r.resultant).toBeGreaterThan(0.9);
    expect(r.p).toBeLessThan(0.001);
  });
});

describe("dayOfWeekAnalysis", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  const addDay = async (date: string, dow: number, headache: boolean) => {
    await d1
      .prepare(
        `INSERT INTO days (local_date, dow, near_location_boundary, fetched_at)
         VALUES (?,?,0,'2026-01-01T00:00:00Z')`
      )
      .bind(date, dow)
      .run();
    if (headache) {
      await d1
        .prepare(
          `INSERT INTO episodes (started_at, local_date, started_at_time_known, source)
           VALUES (?,?,1,'app')`
        )
        .bind(`${date}T12:00:00.000Z`, date)
        .run();
    }
  };

  it("refuses a verdict below the day floor", async () => {
    await addDay("2026-01-01", 4, true);
    const r = await dayOfWeekAnalysis(d1);
    expect(r.verdict).toBe("insufficient data");
    expect(r.p).toBeNull();
  });

  it("finds no pattern when headaches are evenly spread across weekdays", async () => {
    // 14 of each weekday; every other day a headache, cycling so each dow is even.
    let n = 0;
    for (let w = 0; w < 14; w++) {
      for (let dow = 0; dow < 7; dow++) {
        const date = `2026-${String(1 + Math.floor(n / 28)).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")}`;
        await addDay(date, dow, n % 2 === 0);
        n++;
      }
    }
    const r = await dayOfWeekAnalysis(d1);
    expect(r.verdict).not.toBe("insufficient data");
    expect(r.verdict).toBe("no evidence of a pattern");
    expect(r.per_day).toHaveLength(7);
  });

  it("flags a pattern when headaches concentrate on one weekday", async () => {
    let n = 0;
    for (let w = 0; w < 20; w++) {
      for (let dow = 0; dow < 7; dow++) {
        const date = `2026-${String(1 + Math.floor(n / 28)).padStart(2, "0")}-${String((n % 28) + 1).padStart(2, "0")}`;
        // Monday (dow 1) is almost always a headache; other days rarely.
        const headache = dow === 1 ? true : n % 7 === 0;
        await addDay(date, dow, headache);
        n++;
      }
    }
    const r = await dayOfWeekAnalysis(d1);
    expect(r.verdict).toBe("possible pattern");
    expect(r.p!).toBeLessThan(0.05);
  });
});

describe("timeOfDayAnalysis", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  const addAttack = async (iso: string, known: boolean) =>
    d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, tz, source)
         VALUES (?, substr(?,1,10), ?, 'UTC', 'app')`
      )
      .bind(iso, iso, known ? 1 : 0)
      .run();

  it("excludes attacks with an unknown onset time", async () => {
    for (let i = 0; i < 25; i++) await addAttack(`2026-03-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`, false);
    const r = await timeOfDayAnalysis(d1);
    expect(r.known_onset_attacks).toBe(0);
    expect(r.verdict).toBe("insufficient data");
  });

  it("finds no clustering when known onsets are spread across the day", async () => {
    for (let i = 0; i < 24; i++) {
      const h = String(i).padStart(2, "0");
      // two attacks per hour, 48 total, evenly spread
      await addAttack(`2026-03-10T${h}:00:00.000Z`, true);
      await addAttack(`2026-03-11T${h}:30:00.000Z`, true);
    }
    const r = await timeOfDayAnalysis(d1);
    expect(r.known_onset_attacks).toBe(48);
    expect(r.verdict).toBe("no evidence of a pattern");
  });

  it("finds a peak when known onsets cluster in the evening", async () => {
    for (let i = 0; i < 30; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      await addAttack(`2026-03-${day}T20:00:00.000Z`, true); // all around 20:00 UTC
    }
    const r = await timeOfDayAnalysis(d1);
    expect(r.verdict).toBe("possible pattern");
    expect(r.peak_hour).toMatch(/^(19|20|21):/);
    expect(r.p!).toBeLessThan(0.01);
  });
});

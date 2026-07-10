import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, TestD1 } from "./d1-adapter";
import { triggerAnalysis, beliefVsData, premonitionConversion } from "../src/worker/triggers";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function addDay(
  d1: TestD1,
  date: string,
  opts: { pressure_delta_24h?: number; place?: string; boundary?: number } = {}
) {
  await d1
    .prepare(
      `INSERT INTO days (local_date, place, tz, pressure_mean_hpa, pressure_delta_24h,
                         pressure_drop_max_3h, temp_mean_c, temp_max_c, humidity_mean,
                         daylight_hours, dow, near_location_boundary, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, '2026-01-01T00:00:00Z')`
    )
    .bind(
      date,
      opts.place ?? "London, UK",
      "Europe/London",
      1010,
      opts.pressure_delta_24h ?? 0,
      -1,
      12,
      15,
      70,
      12,
      0,
      opts.boundary ?? 0
    )
    .run();
}

async function addEpisode(d1: TestD1, date: string, tags: string | null = null) {
  await d1
    .prepare(
      `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, self_reported_triggers)
       VALUES (?, ?, 1, 'app', ?)`
    )
    .bind(`${date}T12:00:00.000Z`, date, tags)
    .run();
}

describe("triggerAnalysis", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  it("refuses to conclude anything from a handful of days", async () => {
    for (let i = 0; i < 5; i++) await addDay(d1, addDays("2025-01-01", i));
    await addEpisode(d1, "2025-01-01");

    const r = await triggerAnalysis(d1 as unknown as D1Database);
    expect(r.enough_data).toBe(false);
    expect(r.factors.every((f) => f.verdict === "insufficient data")).toBe(true);
  });

  it("reports 'no evidence' when headache days look exactly like control days", async () => {
    // 12 months, 10 headache days and 20 control days each, drawn identically.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    for (let m = 0; m < 12; m++) {
      const base = `2025-${String(m + 1).padStart(2, "0")}-01`;
      for (let i = 0; i < 28; i++) {
        const date = addDays(base, i);
        await addDay(d1, date, { pressure_delta_24h: (rnd() - 0.5) * 10 });
        if (i % 3 === 0) await addEpisode(d1, date);
      }
    }
    const r = await triggerAnalysis(d1 as unknown as D1Database);
    const p = r.factors.find((f) => f.factor === "pressure_delta_24h")!;
    expect(p.n_headache_days).toBeGreaterThanOrEqual(30);
    expect(p.n_control_days).toBeGreaterThanOrEqual(30);
    expect(p.verdict).toBe("no evidence of association");
    expect(r.interpretation).toContain("That is a real result");
  });

  it("detects a planted effect and reports it as an association, never as a cause", async () => {
    // Headache days carry a genuine 8 hPa pressure drop, on top of shared noise.
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    for (let m = 0; m < 12; m++) {
      const base = `2025-${String(m + 1).padStart(2, "0")}-01`;
      for (let i = 0; i < 28; i++) {
        const date = addDays(base, i);
        const headache = i % 3 === 0;
        await addDay(d1, date, {
          pressure_delta_24h: rnd() * 2 + (headache ? -8 : 0),
        });
        if (headache) await addEpisode(d1, date);
      }
    }
    const r = await triggerAnalysis(d1 as unknown as D1Database);
    const p = r.factors.find((f) => f.factor === "pressure_delta_24h")!;
    expect(p.verdict).toBe("possible association");
    expect(p.adjusted_diff!).toBeLessThan(-7);
    expect(p.q!).toBeLessThan(0.05);
    expect(r.interpretation).toContain("not a cause");
  });

  it("does not let season and country masquerade as a trigger", async () => {
    // Within every month, headache and control days are drawn from the SAME
    // distribution, so the true effect is zero. But headaches cluster in the
    // high-pressure Slovak summer. Unstratified that looks like a huge effect.
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);

    for (let m = 0; m < 12; m++) {
      const summer = m >= 5 && m <= 7;
      const place = summer ? "Vienna, AT" : "London, UK";
      const level = summer ? 20 : -20;
      const base = `2025-${String(m + 1).padStart(2, "0")}-01`;
      for (let i = 0; i < 28; i++) {
        const date = addDays(base, i);
        // Noise is drawn independently of headache status: no within-stratum effect.
        await addDay(d1, date, { pressure_delta_24h: level + rnd() * 2, place });
        const headache = summer ? i % 2 === 0 : i % 14 === 0;
        if (headache) await addEpisode(d1, date);
      }
    }
    const r = await triggerAnalysis(d1 as unknown as D1Database);
    const p = r.factors.find((f) => f.factor === "pressure_delta_24h")!;

    expect(Math.abs(p.unadjusted_diff!)).toBeGreaterThan(10); // the lie
    // Cohen calls 0.8 "large". The naive effect size clears that comfortably,
    // which is exactly why gating on it would have published a false trigger.
    expect(Math.abs(p.unadjusted_cohens_d!)).toBeGreaterThan(1);
    expect(Math.abs(p.adjusted_diff!)).toBeLessThan(0.5); // the truth
    expect(Math.abs(p.adjusted_cohens_d!)).toBeLessThan(0.2); // the verdict gates on THIS
    expect(p.verdict).toBe("no evidence of association");
  });

  it("still finds a real within-stratum effect even when a confound is present", async () => {
    // Same seasonal clustering, but now headache days genuinely fall 5 hPa lower
    // inside every month. Stratifying must not wash a true effect away.
    let seed = 5;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);

    for (let m = 0; m < 12; m++) {
      const summer = m >= 5 && m <= 7;
      const place = summer ? "Vienna, AT" : "London, UK";
      const level = summer ? 20 : -20;
      const base = `2025-${String(m + 1).padStart(2, "0")}-01`;
      for (let i = 0; i < 28; i++) {
        const date = addDays(base, i);
        const headache = summer ? i % 2 === 0 : i % 4 === 0;
        await addDay(d1, date, {
          pressure_delta_24h: level + rnd() * 2 + (headache ? -5 : 0),
          place,
        });
        if (headache) await addEpisode(d1, date);
      }
    }
    const r = await triggerAnalysis(d1 as unknown as D1Database);
    const p = r.factors.find((f) => f.factor === "pressure_delta_24h")!;
    expect(p.adjusted_diff!).toBeCloseTo(-5, 0);
    expect(p.verdict).toBe("possible association");
  });

  it("excludes days flagged near a location change", async () => {
    for (let i = 0; i < 5; i++) await addDay(d1, addDays("2025-01-01", i), { boundary: 1 });
    const r = await triggerAnalysis(d1 as unknown as D1Database);
    expect(r.factors[0].n_headache_days + r.factors[0].n_control_days).toBe(0);
    expect(r.excluded).toContain("location change");
  });
});

describe("beliefVsData", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  it("always states that tags have no control group, so they cannot show causation", async () => {
    await addDay(d1, "2025-01-01");
    await addEpisode(d1, "2025-01-01", "Stress; Not enough sleep");
    const r = await beliefVsData(d1 as unknown as D1Database);
    expect(r.limitation).toContain("ONLY on days she had a headache");
    expect(r.limitation).toContain("cannot show");
    expect(r.what_would_make_it_testable).toContain("EVERY day");
    expect(r.tags.map((t) => t.trigger)).toContain("Stress");
  });

  it("does not attempt a comparison for a rarely used tag", async () => {
    await addDay(d1, "2025-01-01");
    await addEpisode(d1, "2025-01-01", "Rare thing");
    const r = await beliefVsData(d1 as unknown as D1Database);
    expect(r.tags.find((t) => t.trigger === "Rare thing")!.comparison).toBeNull();
  });
});

describe("premonitionConversion", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  it("refuses to compare hits against misses until there are enough of both", async () => {
    await addDay(d1, "2026-07-10");
    await d1
      .prepare(`INSERT INTO premonitions (felt_at, local_date, tz, source) VALUES (?,?,?,'app')`)
      .bind("2026-07-10T08:00:00.000Z", "2026-07-10", "Europe/Berlin")
      .run();

    const r = await premonitionConversion(d1 as unknown as D1Database, 24);
    expect(r.enough_data).toBe(false);
    expect(r.followed).toBe(0);
    expect(r.not_followed).toBe(1);
    expect(r.note).toContain("false alarms are the valuable half");
    expect(r.factors.every((f) => f.diff === null)).toBe(true);
  });

  it("counts a premonition as followed only when a headache starts inside the window", async () => {
    await addDay(d1, "2026-07-10");
    await d1
      .prepare(`INSERT INTO premonitions (felt_at, local_date, tz, source) VALUES (?,?,?,'app')`)
      .bind("2026-07-10T08:00:00.000Z", "2026-07-10", "Europe/Berlin")
      .run();
    await addEpisode(d1, "2026-07-10"); // starts 12:00, 4h later

    const r = await premonitionConversion(d1 as unknown as D1Database, 24);
    expect(r.followed).toBe(1);
    expect(r.not_followed).toBe(0);
  });
});

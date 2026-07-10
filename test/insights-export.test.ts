import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";
import { menstrualAnalysis } from "../src/worker/cycle";
import { buildSummary } from "../src/worker/insights";
import { episodesCsv, doctorHtml } from "../src/worker/export";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const PIN = "test-pin";
const authed = { Authorization: `Bearer ${PIN}`, "Content-Type": "application/json" };
function env(d1: TestD1) {
  return { DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } } as never;
}

let d1: TestD1;
beforeEach(() => {
  d1 = freshDb(migrationsDir).d1;
});

const addDay = (date: string, place: string, headache: boolean) =>
  Promise.all([
    d1
      .prepare(
        `INSERT INTO days (local_date, place, tz, near_location_boundary, fetched_at)
         VALUES (?,?,'UTC',0,'2026-01-01T00:00:00Z')`
      )
      .bind(date, place)
      .run(),
    headache
      ? d1
          .prepare(
            `INSERT INTO episodes (started_at, local_date, started_at_time_known, source)
             VALUES (?,?,1,'app')`
          )
          .bind(`${date}T12:00:00.000Z`, date)
          .run()
      : Promise.resolve(),
  ]);

const addPeriod = (date: string) =>
  d1.prepare(`INSERT INTO cycle_events (local_date) VALUES (?)`).bind(date).run();

/** Calendar days from `start`, inclusive. */
function days(start: string, n: number): string[] {
  const out: string[] = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++, t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

describe("menstrualAnalysis", () => {
  it("refuses a verdict with no cycle data, and says why", async () => {
    for (const d of days("2026-01-01", 60)) await addDay(d, "Berlin, DE", false);
    const r = await menstrualAnalysis(d1);
    expect(r.enough_data).toBe(false);
    expect(r.verdict).toBe("insufficient data");
    expect(r.period_starts_logged).toBe(0);
    expect(r.odds_ratio).toBeNull();
    expect(r.exposed_days).toBe(0);
    expect(r.interpretation).toMatch(/logging period starts from now on/);
  });

  it("still refuses when a few months are logged but the strata gate is unmet", async () => {
    // Two months of perfect logging is not six strata.
    for (const d of days("2026-01-01", 60)) await addDay(d, "Berlin, DE", false);
    await addPeriod("2026-01-05");
    await addPeriod("2026-02-02");
    const r = await menstrualAnalysis(d1);
    expect(r.strata_used).toBeLessThan(6);
    expect(r.verdict).toBe("insufficient data");
  });

  it("excludes days after the last logged period rather than calling them unexposed", async () => {
    // Without this, every trailing day becomes a free 'not perimenstrual' control
    // and the odds ratio drifts down for no reason but a missing tap.
    for (const d of days("2026-01-01", 40)) await addDay(d, "Berlin, DE", false);
    await addPeriod("2026-01-03");
    const r = await menstrualAnalysis(d1);
    // 2026-01-03 .. 2026-02-09 is a 38-day run, but the last few days sit past a
    // plausible cycle with no next start, so they cannot be classified.
    expect(r.exposed_days + r.unexposed_days).toBeLessThan(40);
    expect(r.days_with_known_cycle_day).toBeLessThan(40);
  });

  it("finds a planted perimenstrual association once the gates are met", async () => {
    // 8 months, period on the 1st of each. Headache on days 1-3 (in window),
    // and on a fixed handful of mid-cycle days (out of window).
    const starts = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
                    "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
    for (const s of starts) await addPeriod(s);

    for (const d of days("2026-01-01", 220)) {
      const dom = Number(d.slice(8, 10));
      const inWindow = dom <= 3;
      const midCycle = dom === 15;
      await addDay(d, "Berlin, DE", inWindow || midCycle);
    }

    const r = await menstrualAnalysis(d1);
    expect(r.strata_used).toBeGreaterThanOrEqual(6);
    expect(r.enough_data).toBe(true);
    expect(r.verdict).toBe("possible association");
    expect(r.odds_ratio!).toBeGreaterThan(1);
    expect(r.ci_low!).toBeGreaterThan(1);
    expect(r.headache_rate_in_window!).toBeGreaterThan(r.headache_rate_outside!);
    // An association, never a cause.
    expect(r.interpretation).toMatch(/not a cause/);
  });

  it("reports no evidence when headaches ignore the cycle", async () => {
    const starts = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
                    "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
    for (const s of starts) await addPeriod(s);
    // Every 4th day, regardless of where it falls in the cycle.
    let i = 0;
    for (const d of days("2026-01-01", 220)) await addDay(d, "Berlin, DE", i++ % 4 === 0);

    const r = await menstrualAnalysis(d1);
    expect(r.enough_data).toBe(true);
    expect(r.verdict).toBe("no evidence of association");
    expect(r.interpretation).toMatch(/real result, not a failure/);
  });
});

describe("buildSummary", () => {
  it("says nothing it cannot count on an empty database", async () => {
    const s = await buildSummary(d1);
    expect(s.episodes).toBe(0);
    expect(s.months).toEqual([]);
    expect(s.trend.enough_data).toBe(false);
    expect(s.medication_days).toEqual([]);
    const sleep = s.insights.find((i) => i.title === "Sleep")!;
    expect(sleep.body).toMatch(/untestable, not disproven/);
  });

  it("counts headache days, never migraine days", async () => {
    for (const d of ["2026-03-01", "2026-03-01", "2026-03-05"]) {
      await d1
        .prepare(
          `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, severity)
           VALUES (?,?,1,'app',7)`
        )
        .bind(`${d}T09:00:00.000Z`, d)
        .run();
    }
    const s = await buildSummary(d1);
    expect(s.episodes).toBe(3);
    expect(s.headache_days).toBe(2); // two distinct days, three episodes
    const logged = s.insights.find((i) => i.title === "How much you have logged")!;
    expect(logged.body).toMatch(/headache days, not migraine days/);
  });

  it("will not compare quarters until six complete months exist", async () => {
    for (const m of ["01", "02", "03", "04"]) {
      await d1
        .prepare(
          `INSERT INTO episodes (started_at, local_date, started_at_time_known, source)
           VALUES (?,?,1,'app')`
        )
        .bind(`2026-${m}-10T09:00:00.000Z`, `2026-${m}-10`)
        .run();
    }
    const s = await buildSummary(d1);
    expect(s.trend.enough_data).toBe(false);
    const trend = s.insights.find((i) => i.title === "Is it getting worse?")!;
    expect(trend.kind).toBe("gated");
    expect(trend.body).toMatch(/Not enough complete months/);
  });

  it("never infers a medication day from the old trigger tag", async () => {
    // The 'Medication' trigger tag marked that an attack was treated. It is
    // not a medication record, and must not reach the ICHD-3 counter.
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, self_reported_triggers)
         VALUES ('2026-03-01T09:00:00.000Z','2026-03-01',1,'obsidian','Medication')`
      )
      .run();
    const s = await buildSummary(d1);
    expect(s.medication_days).toEqual([]);
    const med = s.insights.find((i) => i.title === "Acute medication days")!;
    expect(med.body).toMatch(/never inferred from the old 'Medication' trigger tag/);
  });

  it("counts a medication day once per class and flags the ICHD-3 threshold", async () => {
    for (const d of days("2026-03-01", 10)) {
      await d1
        .prepare(
          `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, meds)
           VALUES (?,?,1,'app','sumatriptan 50mg')`
        )
        .bind(`${d}T09:00:00.000Z`, d)
        .run();
    }
    const s = await buildSummary(d1);
    expect(s.medication_days).toHaveLength(1);
    expect(s.medication_days[0].triptan_days).toBe(10);
    expect(s.medication_days[0].triptan_threshold_reached).toBe(true);
    const med = s.insights.find((i) => i.title === "Acute medication days")!;
    expect(med.body).toMatch(/does not diagnose/);
  });
});

describe("episodesCsv", () => {
  beforeEach(async () => {
    await addPeriod("2026-03-01");
    await addPeriod("2026-03-29");
    await d1
      .prepare(
        `INSERT INTO days (local_date, place, tz, pressure_mean_hpa, near_location_boundary, fetched_at)
         VALUES ('2026-03-02','Berlin, DE','UTC',1011.5,0,'2026-01-01T00:00:00Z')`
      )
      .run();
    // An app episode: known start, ended, so duration is computable.
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, ended_at, local_date, started_at_time_known, source, severity, note)
         VALUES ('2026-03-02T08:00:00.000Z','2026-03-02T14:30:00.000Z','2026-03-02',1,'app',6,?)`
      )
      .bind('woke with it, "crushing", left side')
      .run();
    // An imported episode: no end time, so no duration. Anchored at local noon.
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, source_file)
         VALUES ('2026-03-10T12:00:00.000Z','2026-03-10',0,'obsidian','note.md')`
      )
      .run();
  });

  it("computes duration only where an end time exists", async () => {
    const rows = (await episodesCsv(d1)).split("\n");
    const header = rows[0].split(",");
    const dur = header.indexOf("duration_hours");
    const byDate = Object.fromEntries(rows.slice(1).map((r) => [r.slice(0, 10), r]));
    // Note contains commas and quotes, so split() is not safe: check the fields
    // positionally only on the imported row, which has no free text.
    expect(byDate["2026-03-10"].split(",")[dur]).toBe("");
    expect(byDate["2026-03-02"]).toContain("6.50");
  });

  it("escapes a note containing commas and quotes", async () => {
    const csv = await episodesCsv(d1);
    expect(csv).toContain('"woke with it, ""crushing"", left side"');
    // The header count must survive the note: one physical line per episode.
    expect(csv.split("\n")).toHaveLength(3);
  });

  it("derives cycle_day from the period events rather than storing it", async () => {
    const rows = (await episodesCsv(d1)).split("\n");
    const idx = rows[0].split(",").indexOf("cycle_day");
    const imported = rows.find((r) => r.startsWith("2026-03-10"))!;
    expect(imported.split(",")[idx]).toBe("10"); // 2026-03-01 is day 1
  });

  it("leaves cycle_day blank when the day predates the first logged period", async () => {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source)
         VALUES ('2026-02-01T12:00:00.000Z','2026-02-01',0,'obsidian')`
      )
      .run();
    const rows = (await episodesCsv(d1)).split("\n");
    const idx = rows[0].split(",").indexOf("cycle_day");
    const early = rows.find((r) => r.startsWith("2026-02-01"))!;
    expect(early.split(",")[idx]).toBe("");
  });
});

describe("doctorHtml", () => {
  it("leads with monthly headache days and disclaims diagnosis", async () => {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, severity)
         VALUES ('2026-03-02T08:00:00.000Z','2026-03-02',1,'app',6)`
      )
      .run();
    const html = await doctorHtml(d1);
    expect(html).toContain("<h2>Monthly headache days</h2>");
    expect(html).toMatch(/does not diagnose/);
    expect(html).toMatch(/ICHD-3 criteria cannot be verified/);
  });

  it("escapes a note that would otherwise inject markup", async () => {
    await d1
      .prepare(
        `INSERT INTO cycle_events (local_date) VALUES ('2026-03-01')`
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, meds)
         VALUES ('2026-03-02T08:00:00.000Z','2026-03-02',1,'app',?)`
      )
      .bind("<script>alert(1)</script>")
      .run();
    const html = await doctorHtml(d1);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("cycle routes", () => {
  it("rejects a date that is not YYYY-MM-DD", async () => {
    const res = await app.request(
      "/api/cycle",
      { method: "POST", headers: authed, body: JSON.stringify({ local_date: "1 March" }) },
      env(d1)
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body that is not JSON at all", async () => {
    const res = await app.request(
      "/api/cycle",
      { method: "POST", headers: authed, body: "not json" },
      env(d1)
    );
    expect(res.status).toBe(400);
  });

  it("is idempotent: tapping twice on one day logs one period start", async () => {
    const body = JSON.stringify({ local_date: "2026-03-01" });
    await app.request("/api/cycle", { method: "POST", headers: authed, body }, env(d1));
    const second = await app.request(
      "/api/cycle",
      { method: "POST", headers: authed, body },
      env(d1)
    );
    expect(second.status).toBe(201);

    const list = await app.request("/api/cycle", { headers: authed }, env(d1));
    expect(await list.json()).toHaveLength(1);
  });

  it("deletes a mistaken tap and 404s the second time", async () => {
    await app.request(
      "/api/cycle",
      { method: "POST", headers: authed, body: JSON.stringify({ local_date: "2026-03-01" }) },
      env(d1)
    );
    const rows = (await (
      await app.request("/api/cycle", { headers: authed }, env(d1))
    ).json()) as Array<{ id: number }>;

    const del = await app.request(
      `/api/cycle/${rows[0].id}`,
      { method: "DELETE", headers: authed },
      env(d1)
    );
    expect(del.status).toBe(200);
    const again = await app.request(
      `/api/cycle/${rows[0].id}`,
      { method: "DELETE", headers: authed },
      env(d1)
    );
    expect(again.status).toBe(404);
  });

  it("guards every new route behind the PIN", async () => {
    for (const path of ["/api/cycle", "/api/cycle/analysis", "/api/summary", "/api/export/doctor"]) {
      const res = await app.request(path, {}, env(d1));
      expect(res.status, path).toBe(401);
    }
  });
});

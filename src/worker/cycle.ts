// F13: menstrual cycle capture and analysis.
//
// A perimenstrual window is a BINARY exposure, so it is tested with a
// Mantel-Haenszel odds ratio (headache odds inside the window vs outside),
// stratified by (place, month) exactly as the continuous factors are. Feeding it
// to a difference-in-means test would be meaningless.
//
// The cycle day of every calendar day is DERIVED from the period-start events at
// query time, never stored. A forgotten period added later silently corrects every
// day that depended on it.

import { mantelHaenszelOR, round, type Table2x2 } from "../shared/stats";
import { cycleContext, normalizeStarts, WINDOW_AFTER, WINDOW_BEFORE } from "../shared/cycle";

const MIN_EXPOSED = 20;
const MIN_UNEXPOSED = 20;
const MIN_STRATA = 6;

export type Verdict = "insufficient data" | "no evidence of association" | "possible association";

export interface MenstrualAnalysis {
  method: string;
  window: string;
  period_starts_logged: number;
  days_with_known_cycle_day: number;
  strata_used: number;
  exposed_days: number;
  unexposed_days: number;
  headache_rate_in_window: number | null;
  headache_rate_outside: number | null;
  crude_odds_ratio: number | null;
  odds_ratio: number | null;
  ci_low: number | null;
  ci_high: number | null;
  p: number | null;
  enough_data: boolean;
  verdict: Verdict;
  interpretation: string;
}

export async function loadPeriodStarts(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare(`SELECT local_date FROM cycle_events WHERE kind = 'period_start' ORDER BY local_date`)
    .all<{ local_date: string }>();
  return normalizeStarts(res.results.map((r) => r.local_date));
}

export async function menstrualAnalysis(db: D1Database): Promise<MenstrualAnalysis> {
  const starts = await loadPeriodStarts(db);

  const days = await db
    .prepare(
      `SELECT d.local_date, d.place,
              EXISTS (SELECT 1 FROM episodes e WHERE e.local_date = d.local_date) AS had_headache
         FROM days d
        WHERE d.near_location_boundary = 0
        ORDER BY d.local_date`
    )
    .all<{ local_date: string; place: string | null; had_headache: number }>();

  const tables = new Map<string, Table2x2>();
  let known = 0;

  for (const row of days.results) {
    const ctx = cycleContext(row.local_date, starts);
    if (ctx.cycle_day !== null) known++;
    // A day whose window status cannot be known is excluded, never assumed 'false'.
    if (ctx.perimenstrual === null) continue;

    const key = `${row.place ?? "?"}|${row.local_date.slice(0, 7)}`;
    let t = tables.get(key);
    if (!t) {
      t = { key, a: 0, b: 0, c: 0, d: 0 };
      tables.set(key, t);
    }
    if (ctx.perimenstrual) row.had_headache ? t.a++ : t.b++;
    else row.had_headache ? t.c++ : t.d++;
  }

  const r = mantelHaenszelOR([...tables.values()]);

  const enough =
    r.exposed_days >= MIN_EXPOSED &&
    r.unexposed_days >= MIN_UNEXPOSED &&
    r.strata_used >= MIN_STRATA &&
    r.p !== null;

  let verdict: Verdict;
  if (!enough) verdict = "insufficient data";
  else if (r.p! < 0.05 && (r.ci_low! > 1 || r.ci_high! < 1)) verdict = "possible association";
  else verdict = "no evidence of association";

  const rateIn = r.exposed_days ? r.exposed_headache_days / r.exposed_days : null;
  const rateOut = r.unexposed_days ? r.unexposed_headache_days / r.unexposed_days : null;

  return {
    method:
      "Mantel-Haenszel odds ratio for a binary exposure, stratified by (place, month) so season and country cannot leak in. Days whose cycle day cannot be known (before the first logged period, inside a gap longer than 45 days, or after the last logged period) are excluded rather than assumed.",
    window: `Day -${WINDOW_BEFORE} to +${WINDOW_AFTER} around a period start.`,
    period_starts_logged: starts.length,
    days_with_known_cycle_day: known,
    strata_used: r.strata_used,
    exposed_days: r.exposed_days,
    unexposed_days: r.unexposed_days,
    headache_rate_in_window: round(rateIn, 3),
    headache_rate_outside: round(rateOut, 3),
    crude_odds_ratio: round(r.crude_or, 3),
    odds_ratio: round(r.or, 3),
    ci_low: round(r.ci_low, 3),
    ci_high: round(r.ci_high, 3),
    p: round(r.p, 4),
    enough_data: enough,
    verdict,
    interpretation: !enough
      ? `Needs at least ${MIN_EXPOSED} days inside the window, ${MIN_UNEXPOSED} outside, and ${MIN_STRATA} (place, month) strata. Currently ${r.exposed_days}, ${r.unexposed_days} and ${r.strata_used}. There is no cycle data in her history, so this can only be answered by logging period starts from now on: roughly six months of tapping once a month.`
      : verdict === "possible association"
        ? "The odds of a headache differ inside the perimenstrual window. This is an association on observational data, not a cause, and it is not medical advice."
        : "No evidence that headache odds differ inside the perimenstrual window, at these thresholds. That is a real result, not a failure.",
  };
}

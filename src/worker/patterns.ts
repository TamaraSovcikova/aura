// Day-of-week and time-of-day patterns.
//
// Both run on data already captured, no new tracking: `days.dow` is stored for every
// backfilled day, and every episode carries an onset timestamp. Both hold to the same
// rule as the trigger engine: refuse to conclude below a floor, and say so plainly.
//
//   * Day of week is CATEGORICAL, so it uses a chi-square test of whether headache
//     incidence depends on the weekday. Day of week is near-orthogonal to season and
//     place (each month carries roughly equal weekdays), so it is not stratified.
//   * Time of day is CIRCULAR (23:00 sits next to 01:00), so it uses a Rayleigh test
//     for a preferred hour rather than binning, which would mishandle the midnight
//     wrap. Only KNOWN onset times count: an imported row anchored at local noon would
//     invent a noon spike.

import { chiSquareContingency, rayleighTest, round } from "../shared/stats";

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Verdict = "insufficient data" | "no evidence of a pattern" | "possible pattern";

export interface DayOfWeekAnalysis {
  method: string;
  days_analysed: number;
  per_day: Array<{ day: string; headache_days: number; total_days: number; rate: number | null }>;
  chi2: number | null;
  p: number | null;
  verdict: Verdict;
  interpretation: string;
}

export async function dayOfWeekAnalysis(db: D1Database): Promise<DayOfWeekAnalysis> {
  const res = await db
    .prepare(
      `SELECT d.dow AS dow,
              EXISTS (SELECT 1 FROM episodes e WHERE e.local_date = d.local_date) AS had_headache
         FROM days d
        WHERE d.dow IS NOT NULL`
    )
    .all<{ dow: number; had_headache: number }>();

  // table[dow] = [headache days, non-headache days]
  const table = Array.from({ length: 7 }, () => [0, 0]);
  for (const r of res.results) table[r.dow][r.had_headache ? 0 : 1]++;

  const perDay = table.map((t, i) => {
    const total = t[0] + t[1];
    return { day: DOW_LABELS[i], headache_days: t[0], total_days: total, rate: total ? round(t[0] / total, 3) : null };
  });

  const total = res.results.length;
  const minDayTotal = Math.min(...table.map((t) => t[0] + t[1]));
  const chi = chiSquareContingency(table);
  const enough = total >= 90 && minDayTotal >= 5 && chi.min_expected >= 5;

  const verdict: Verdict = !enough
    ? "insufficient data"
    : chi.p < 0.05
      ? "possible pattern"
      : "no evidence of a pattern";

  return {
    method:
      "Chi-square test of whether a day being a headache day depends on the day of the week. Day of week is near-independent of season and place, so it is not stratified.",
    days_analysed: total,
    per_day: perDay,
    chi2: enough ? round(chi.chi2, 3) : null,
    p: enough ? round(chi.p, 4) : null,
    verdict,
    interpretation: !enough
      ? `Needs at least 90 days with at least 5 per weekday. Currently ${total} days.`
      : verdict === "possible pattern"
        ? "Headache days are not evenly spread across the week. This is an association on observational data, not a cause."
        : "No evidence that any weekday carries more headache days than another. That is a real result.",
  };
}

// ── Time of day ──────────────────────────────────────────────────────────────

/** The local clock hour (0-24, fractional) of an instant in its timezone. */
function localHour(iso: string, tz: string | null): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz ?? "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) + m / 60;
  } catch {
    return null;
  }
}

const PERIODS = [
  { label: "night (0-6)", from: 0, to: 6 },
  { label: "morning (6-12)", from: 6, to: 12 },
  { label: "afternoon (12-18)", from: 12, to: 18 },
  { label: "evening (18-24)", from: 18, to: 24 },
];

export interface TimeOfDayAnalysis {
  method: string;
  known_onset_attacks: number;
  peak_hour: string | null;
  concentration: number | null;
  p: number | null;
  by_period: Array<{ label: string; count: number }>;
  verdict: Verdict;
  interpretation: string;
}

const fmtHour = (h: number): string => {
  const hh = String(Math.floor(h) % 24).padStart(2, "0");
  const mm = String(Math.round((h % 1) * 60) % 60).padStart(2, "0");
  return `${hh}:${mm}`;
};

export async function timeOfDayAnalysis(db: D1Database): Promise<TimeOfDayAnalysis> {
  const res = await db
    .prepare(`SELECT started_at, tz FROM episodes WHERE started_at_time_known = 1`)
    .all<{ started_at: string; tz: string | null }>();

  const hours = res.results
    .map((r) => localHour(r.started_at, r.tz))
    .filter((h): h is number => h !== null);

  const byPeriod = PERIODS.map((p) => ({
    label: p.label,
    count: hours.filter((h) => h >= p.from && h < p.to).length,
  }));

  const ray = rayleighTest(hours.map((h) => (h / 24) * 2 * Math.PI));
  const enough = hours.length >= 20;

  // Mean angle -> peak hour, wrapped into [0, 24).
  const peakHour =
    enough && Number.isFinite(ray.mean_angle)
      ? (((ray.mean_angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 24
      : null;

  const verdict: Verdict = !enough
    ? "insufficient data"
    : ray.p < 0.05
      ? "possible pattern"
      : "no evidence of a pattern";

  return {
    method:
      "Rayleigh test for a preferred hour of onset. Only attacks with a known onset time are counted; estimated and woken-with onsets are excluded so they cannot invent a spike. Time is treated as circular, so late night and early morning are neighbours.",
    known_onset_attacks: hours.length,
    peak_hour: peakHour !== null ? fmtHour(peakHour) : null,
    concentration: enough ? round(ray.resultant, 3) : null,
    p: enough ? round(ray.p, 4) : null,
    by_period: byPeriod,
    verdict,
    interpretation: !enough
      ? `Needs at least 20 attacks with a known onset time. Currently ${hours.length}.`
      : verdict === "possible pattern"
        ? `Onset clusters around ${peakHour !== null ? fmtHour(peakHour) : "a time of day"}. This describes when attacks tend to start; it is not a cause.`
        : "No evidence that attacks cluster at any time of day, among the ones with a known onset.",
  };
}

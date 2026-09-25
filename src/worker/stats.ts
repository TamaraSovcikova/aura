// Derived statistics. Shared by the REST API and the MCP server so the two can
// never drift apart and report different numbers for the same question.
//
// All time comparisons go through julianday(). SQLite's datetime() returns
// 'YYYY-MM-DD HH:MM:SS' while our timestamps are 'YYYY-MM-DDTHH:MM:SS.sssZ';
// comparing those as strings is wrong ('T' sorts after ' ').

/** ICHD-3 caps an untreated migraine attack at 72h. An episode with no ended_at
 *  is assumed to have run at most that long, so one attack she forgot to end
 *  cannot look "ongoing forever" and swallow every later premonition. */
const OPEN_EPISODE_CAP = "+72 hours";

export interface PremonitionStats {
  window_hours: number;
  premonitions_eligible: number;
  followed_by_headache: number;
  hit_rate: number | null;
  warning_rate: number | null;
  lead_hours_median: number | null;
  lead_hours_min: number | null;
  lead_hours_max: number | null;
  enough_data: boolean;
}

export async function premonitionStats(
  db: D1Database,
  windowHours: number
): Promise<PremonitionStats> {
  const windowDays = windowHours / 24;

  const paired = await db
    .prepare(
      `WITH eligible AS (
         SELECT p.id, p.felt_at
           FROM premonitions p
          WHERE NOT EXISTS (
            SELECT 1 FROM episodes e
             WHERE e.source = 'app'
               AND julianday(e.started_at) <= julianday(p.felt_at)
               AND julianday(COALESCE(e.ended_at, datetime(e.started_at, '${OPEN_EPISODE_CAP}')))
                   >= julianday(p.felt_at)
          )
       )
       SELECT g.id,
              g.felt_at,
              (SELECT min(e.started_at) FROM episodes e
                WHERE e.started_at_time_known = 1
                  AND julianday(e.started_at) > julianday(g.felt_at)
                  AND julianday(e.started_at) <= julianday(g.felt_at) + ?) AS next_start
         FROM eligible g`
    )
    .bind(windowDays)
    .all<{ id: number; next_start: string | null; felt_at: string }>();

  const rows = paired.results;
  const followed = rows.filter((r) => r.next_start !== null);
  const leads = followed
    .map((r) => (Date.parse(r.next_start!) - Date.parse(r.felt_at)) / 3600000)
    .sort((a, b) => a - b);

  // Only episodes with a known start time can be said to have been "warned":
  // an imported row anchored at local noon would produce a fictional lead time.
  const totalEpisodes = await db
    .prepare(`SELECT count(*) AS n FROM episodes WHERE started_at_time_known = 1`)
    .first<{ n: number }>();
  const warned = await db
    .prepare(
      `SELECT count(*) AS n FROM episodes e
        WHERE e.started_at_time_known = 1
          AND EXISTS (SELECT 1 FROM premonitions p
                       WHERE julianday(p.felt_at) < julianday(e.started_at)
                         AND julianday(e.started_at) <= julianday(p.felt_at) + ?)`
    )
    .bind(windowDays)
    .first<{ n: number }>();

  return {
    window_hours: windowHours,
    premonitions_eligible: rows.length,
    followed_by_headache: followed.length,
    hit_rate: rows.length ? followed.length / rows.length : null,
    warning_rate: totalEpisodes?.n ? (warned?.n ?? 0) / totalEpisodes.n : null,
    lead_hours_median: leads.length ? leads[Math.floor((leads.length - 1) / 2)] : null,
    lead_hours_min: leads.length ? leads[0] : null,
    lead_hours_max: leads.length ? leads[leads.length - 1] : null,
    // Refusing to conclude is a feature. A handful of taps means nothing.
    enough_data: rows.length >= 10 && followed.length >= 3,
  };
}

export interface MonthRow {
  month: string; // YYYY-MM
  headache_days: number;
  avg_severity: number | null;
}

export interface MonthPoint extends MonthRow {
  /** False when the observation window does not cover the whole calendar month. */
  complete: boolean;
}

const lastDayOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

const nextMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * Turn the sparse GROUP BY result into a contiguous monthly series.
 *
 * Two traps this closes:
 *  - A month with ZERO headache days does not appear in a GROUP BY at all. That is
 *    the best possible month, and dropping it would inflate every average and slide
 *    the trend window over a gap.
 *  - The first and last months are usually only partly observed (she started
 *    logging mid-August 2024; the current month is still running). Averaging a
 *    3-day month against full ones invents an improvement that is not there.
 */
export function monthSeries(
  rows: MonthRow[],
  firstDay: string | null,
  today: string
): MonthPoint[] {
  if (!firstDay) return [];
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out: MonthPoint[] = [];
  const lastMonth = today.slice(0, 7);

  for (let m = firstDay.slice(0, 7); m <= lastMonth; m = nextMonth(m)) {
    const hit = byMonth.get(m);
    const monthStart = `${m}-01`;
    const monthEnd = lastDayOf(m);
    out.push({
      month: m,
      headache_days: hit?.headache_days ?? 0,
      avg_severity: hit?.avg_severity ?? null,
      complete: monthStart >= firstDay && monthEnd <= today,
    });
  }
  return out;
}

export async function monthlyHeadacheDays(
  db: D1Database,
  from?: string,
  to?: string
): Promise<MonthRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (from) {
    where.push("local_date >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("local_date <= ?");
    binds.push(to);
  }
  const sql =
    `SELECT substr(local_date, 1, 7) AS month,
            count(DISTINCT local_date) AS headache_days,
            round(avg(severity), 1) AS avg_severity
       FROM episodes
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      GROUP BY month ORDER BY month`;
  const res = await db.prepare(sql).bind(...binds).all<MonthRow>();
  return res.results;
}

/**
 * Rolling 3-month mean of headache days, compared against the previous 3 months.
 *
 * Only COMPLETE months are used. Including the current, still-running month makes
 * the recent mean look artificially low and can fabricate a ">=50% reduction",
 * which is the threshold clinicians read as a treatment response. Partial months
 * are therefore excluded.
 */
export type TrendResult =
  | { enough_data: false; complete_months: number; note: string }
  | {
      enough_data: true;
      excluded_partial_months: string[];
      recent_3_months: string[];
      prior_3_months: string[];
      recent_mean_headache_days: number;
      prior_mean_headache_days: number;
      percent_change: number | null;
      meets_50pct_reduction: boolean;
    };

export function headacheDaysTrend(series: MonthPoint[]): TrendResult {
  const complete = series.filter((m) => m.complete);
  if (complete.length < 6) {
    return {
      enough_data: false,
      complete_months: complete.length,
      note: "Needs 6 complete months to compare one quarter against the previous one. Partial months are excluded because averaging a part-month against full ones invents a change that is not there.",
    };
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const recent = complete.slice(-3);
  const prior = complete.slice(-6, -3);
  const recentMean = mean(recent.map((m) => m.headache_days));
  const priorMean = mean(prior.map((m) => m.headache_days));
  const pctChange = priorMean === 0 ? null : ((recentMean - priorMean) / priorMean) * 100;

  return {
    enough_data: true,
    excluded_partial_months: series.filter((m) => !m.complete).map((m) => m.month),
    recent_3_months: recent.map((m) => m.month),
    prior_3_months: prior.map((m) => m.month),
    recent_mean_headache_days: Number(recentMean.toFixed(1)),
    prior_mean_headache_days: Number(priorMean.toFixed(1)),
    percent_change: pctChange === null ? null : Number(pctChange.toFixed(1)),
    // A >=50% reduction is the clinical convention for treatment response. Reported
    // as an observation about counts, never as a claim that a treatment worked.
    meets_50pct_reduction: pctChange !== null && pctChange <= -50,
  };
}

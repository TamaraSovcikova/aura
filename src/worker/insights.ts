// F5 / F6 / F8: the dashboard summary, the medication-day counter, and the
// deterministic insight cards.
//
// The cards are computed here, not written by an LLM. Aura states only what it can
// count, and every claim that depends on a statistical test carries that test's
// gate with it. A card that would need evidence Aura does not have says so rather
// than softening into "a slight trend".

import { headacheDaysTrend, monthSeries, monthlyHeadacheDays, type MonthPoint, type TrendResult } from "./stats";
import { medicationDays, ICHD3_THRESHOLDS, type MedMonth } from "../shared/meds";
import { triggerAnalysis } from "./triggers";
import { premonitionStats } from "./stats";
import { menstrualAnalysis } from "./cycle";

export interface Insight {
  /** 'fact' = a count. 'gated' = depends on a test that reports its own power. */
  kind: "fact" | "gated";
  title: string;
  body: string;
}

export interface Summary {
  first_day: string | null;
  last_day: string | null;
  episodes: number;
  headache_days: number;
  months: MonthPoint[];
  trend: TrendResult;
  severity_distribution: Array<{ severity: number; n: number }>;
  mean_peak_severity: number | null;
  medication_days: MedMonth[];
  control_days: { total: number; with_sleep: number };
  insights: Insight[];
}

const pct = (v: number) => `${v > 0 ? "+" : ""}${v}%`;

export async function buildSummary(db: D1Database): Promise<Summary> {
  const span = await db
    .prepare(
      `SELECT min(local_date) AS first, max(local_date) AS last,
              count(*) AS episodes, count(DISTINCT local_date) AS headache_days,
              round(avg(severity), 2) AS mean_sev
         FROM episodes`
    )
    .first<{ first: string | null; last: string | null; episodes: number; headache_days: number; mean_sev: number | null }>();

  const months = monthSeries(await monthlyHeadacheDays(db), span?.first ?? null, span?.last ?? "");
  const trend = headacheDaysTrend(months);

  const dist = await db
    .prepare(
      `SELECT severity, count(*) AS n FROM episodes
        WHERE severity IS NOT NULL GROUP BY severity ORDER BY severity`
    )
    .all<{ severity: number; n: number }>();

  const medRows = await db
    .prepare(`SELECT local_date, meds FROM episodes WHERE meds IS NOT NULL AND meds <> ''`)
    .all<{ local_date: string; meds: string }>();
  const meds = medicationDays(medRows.results);

  const control = await db
    .prepare(
      `SELECT count(*) AS total, sum(sleep_minutes IS NOT NULL) AS with_sleep FROM days`
    )
    .first<{ total: number; with_sleep: number }>();

  const insights: Insight[] = [];
  const complete = months.filter((m) => m.complete);

  // ── Counts. These are facts, not inferences. ──────────────────────────────
  if (span?.episodes) {
    insights.push({
      kind: "fact",
      title: "How much you have logged",
      body: `${span.headache_days} headache days across ${months.length} months (${span.first} to ${span.last}). These are headache days, not migraine days: ICHD-3 criteria cannot be checked on the imported history.`,
    });
  }

  if (complete.length) {
    const mean = complete.reduce((s, m) => s + m.headache_days, 0) / complete.length;
    const worst = complete.reduce((a, b) => (b.headache_days > a.headache_days ? b : a));
    insights.push({
      kind: "fact",
      title: "Your typical month",
      body: `${mean.toFixed(1)} headache days per complete month. The worst was ${worst.month} with ${worst.headache_days}.`,
    });
  }

  // ── Trend. Carries its own gate. ──────────────────────────────────────────
  if (trend.enough_data) {
    const t = trend;
    insights.push({
      kind: "gated",
      title: "Is it getting worse?",
      body:
        `Last three complete months averaged ${t.recent_mean_headache_days} headache days, against ${t.prior_mean_headache_days} in the three before (${pct(t.percent_change ?? 0)}). ` +
        (t.meets_50pct_reduction
          ? "That meets the >=50% reduction clinicians read as a treatment response, but it is an observation about counts, not evidence that any treatment worked."
          : "That does not meet the >=50% change clinicians treat as a meaningful shift.") +
        (t.excluded_partial_months.length
          ? ` Partial months excluded: ${t.excluded_partial_months.join(", ")}.`
          : ""),
    });
  } else {
    insights.push({
      kind: "gated",
      title: "Is it getting worse?",
      body: "Not enough complete months to compare one quarter against the previous one.",
    });
  }

  // ── Medication days. The most clinically useful number Aura can show. ──────
  if (meds.length) {
    const flagged = meds.filter((m) => m.triptan_threshold_reached || m.analgesic_threshold_reached);
    const recent = meds.slice(-3);
    insights.push({
      kind: "fact",
      title: "Acute medication days",
      body:
        `Recent months: ${recent.map((m) => `${m.month} ${m.medication_days}d`).join(", ")}. ` +
        (flagged.length
          ? `${flagged.length} month(s) reached an ICHD-3 day count (triptans >=${ICHD3_THRESHOLDS.triptan}/month, simple analgesics >=${ICHD3_THRESHOLDS.simple_analgesic}/month). Sustained beyond three months this is what a neurologist would want to discuss. Aura counts; it does not diagnose.`
          : `No month reached an ICHD-3 day count (triptans >=${ICHD3_THRESHOLDS.triptan}, simple analgesics >=${ICHD3_THRESHOLDS.simple_analgesic}).`),
    });
  } else {
    insights.push({
      kind: "fact",
      title: "Acute medication days",
      body: "No medication entries yet. This counts only what you record when you end an attack; it is never inferred from the old 'Medication' trigger tag, which marked that an attack was treated, not how often.",
    });
  }

  // ── Triggers. Only ever the verdict. ──────────────────────────────────────
  const trig = await triggerAnalysis(db);
  const hits = trig.factors.filter((f) => f.verdict === "possible association");
  const tested = trig.factors.filter((f) => f.verdict !== "insufficient data");
  insights.push({
    kind: "gated",
    title: "Weather and your headaches",
    body: tested.length
      ? hits.length
        ? `${hits.map((h) => h.label).join(", ")} show a possible association. An association, not a cause.`
        : `${tested.length} factors tested across your headache days and control days. None shows evidence of an association. That is a real result: these weather variables do not explain your headache days.`
      : "Not enough control days yet to test any factor.",
  });

  // ── Sleep. Untestable is not the same as disproven. ────────────────────────
  const withSleep = control?.with_sleep ?? 0;
  insights.push({
    kind: "gated",
    title: "Sleep",
    body:
      withSleep > 0
        ? `${withSleep} days carry sleep data. Roughly six months of continuous nightly data are needed before sleep can return a verdict.`
        : "No sleep data yet, so 'not enough sleep' remains untestable, not disproven. It was only ever recorded on days you already had a headache, which leaves no control group. A wearable writing to Health Connect fixes that.",
  });

  // ── Premonitions and cycle. Both carry their own gates. ────────────────────
  const prem = await premonitionStats(db, 24);
  insights.push({
    kind: "gated",
    title: "\"I feel one coming\"",
    body: prem.enough_data
      ? `${Math.round((prem.hit_rate ?? 0) * 100)}% of your premonitions were followed by a headache within 24 hours, with a median lead of ${prem.lead_hours_median} hours.`
      : `${prem.premonitions_eligible} logged so far. Needs 10 premonitions and 3 that were followed. The ones that come to nothing are the valuable half.`,
  });

  const cyc = await menstrualAnalysis(db);
  insights.push({
    kind: "gated",
    title: "Menstrual cycle",
    body: cyc.enough_data
      ? `Headache odds inside the perimenstrual window: ${cyc.odds_ratio}x (95% CI ${cyc.ci_low} to ${cyc.ci_high}). ${cyc.verdict}.`
      : `${cyc.period_starts_logged} period starts logged. There is no cycle data in your history, so this can only be answered by tapping once a month from now on.`,
  });

  return {
    first_day: span?.first ?? null,
    last_day: span?.last ?? null,
    episodes: span?.episodes ?? 0,
    headache_days: span?.headache_days ?? 0,
    months,
    trend,
    severity_distribution: dist.results,
    mean_peak_severity: span?.mean_sev ?? null,
    medication_days: meds,
    control_days: { total: control?.total ?? 0, with_sleep: withSleep },
    insights,
  };
}

// F9 / F10 / F20: the trigger engine.
//
// Design rule, above all else: refusing to conclude is a feature. Competitors sell
// "Trigger Maps". This returns "no evidence of association" or "insufficient data"
// whenever that is the truth, and it says so in the same voice it would use for a
// real finding.
//
// Three guards against fooling ourselves:
//   1. STRATIFICATION. Pressure differs by country and by season. Every comparison
//      is made within one (place, month), and only within-stratum differences are
//      pooled. A Slovak August is never compared against a British January.
//   2. MULTIPLE COMPARISONS. Every factor with data is tested at once, so one in
//      twenty would look significant by chance. Benjamini-Hochberg q-values are
//      reported, never raw p-values alone. A factor with no data yields no p-value
//      and is excluded from the correction, so an empty column cannot dilute a
//      real result simply by existing.
//   3. POWER GATING. Below a floor of cases, controls and strata, nothing is
//      reported at all.

import type { Bindings } from "./db";
import {
  benjaminiHochberg,
  round,
  stratifiedMeanDiff,
  type Stratum,
} from "../shared/stats";

export const FACTORS = [
  { key: "pressure_delta_24h", label: "24-hour change in mean pressure (hPa)" },
  { key: "pressure_drop_max_3h", label: "Sharpest 3-hour pressure fall (hPa)" },
  { key: "pressure_mean_hpa", label: "Mean daily pressure (hPa)" },
  { key: "temp_mean_c", label: "Mean daily temperature (C)" },
  { key: "temp_max_c", label: "Maximum daily temperature (C)" },
  { key: "humidity_mean", label: "Mean relative humidity (%)" },
  { key: "daylight_hours", label: "Daylight hours" },
  // On-device factors (F14). Present only once a Health Connect reader or a CSV
  // export starts pushing them; until then every one reports "insufficient data"
  // and is excluded from the multiple-comparison correction, so it cannot weaken
  // the weather results by merely existing.
  { key: "sleep_minutes", label: "Sleep the night before (minutes)" },
  { key: "sleep_efficiency", label: "Sleep efficiency (asleep / in bed)" },
  { key: "steps", label: "Steps" },
  { key: "resting_hr", label: "Resting heart rate (bpm)" },
  { key: "hrv_ms", label: "Heart-rate variability (ms)" },
] as const;

type FactorKey = (typeof FACTORS)[number]["key"];

const MIN_CASES = 30;
const MIN_CONTROLS = 30;
const MIN_STRATA = 6;
/** Below this standardized effect, a "significant" result is not worth acting on. */
const MIN_EFFECT = 0.2;
/** A tag needs this many headache days before any comparison is attempted. */
const MIN_TAGGED_DAYS = 20;

export interface JoinedDay extends Record<string, number | string | null> {
  local_date: string;
  place: string | null;
  had_headache: number;
}

/**
 * Every day, with the objective factors and whether a headache occurred.
 *
 * `had_headache` is derived by joining on local_date, never stored, so it cannot
 * go stale. Days flagged near a location change are excluded: a front may have
 * passed while she travelled, so the weather may belong to the wrong place.
 */
export async function loadJoinedDays(db: D1Database): Promise<JoinedDay[]> {
  const cols = FACTORS.map((f) => f.key).join(", ");
  const res = await db
    .prepare(
      `SELECT d.local_date, d.place, ${cols},
              EXISTS (SELECT 1 FROM episodes e WHERE e.local_date = d.local_date) AS had_headache
         FROM days d
        WHERE d.near_location_boundary = 0
        ORDER BY d.local_date`
    )
    .all<JoinedDay>();
  return res.results;
}

/** One stratum per (place, calendar month). */
function buildStrata(rows: JoinedDay[], factor: FactorKey): Stratum[] {
  const map = new Map<string, Stratum>();
  for (const r of rows) {
    const v = r[factor];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const key = `${r.place ?? "?"}|${r.local_date.slice(0, 7)}`;
    let s = map.get(key);
    if (!s) {
      s = { key, cases: [], controls: [] };
      map.set(key, s);
    }
    (r.had_headache ? s.cases : s.controls).push(v);
  }
  return [...map.values()];
}

export type Verdict =
  | "insufficient data"
  | "no evidence of association"
  | "possible association";

export interface FactorResult {
  factor: FactorKey;
  label: string;
  n_headache_days: number;
  n_control_days: number;
  strata_used: number;
  unadjusted_diff: number | null;
  adjusted_diff: number | null;
  ci_low: number | null;
  ci_high: number | null;
  /** CONFOUNDED whenever strata differ. Shown only to expose what stratifying changed. */
  unadjusted_cohens_d: number | null;
  /** The effect size the verdict is gated on. */
  adjusted_cohens_d: number | null;
  p: number | null;
  q: number | null;
  verdict: Verdict;
}

export interface TriggerAnalysis {
  method: string;
  excluded: string;
  thresholds: Record<string, number>;
  enough_data: boolean;
  factors: FactorResult[];
  interpretation: string;
}

export async function triggerAnalysis(db: D1Database): Promise<TriggerAnalysis> {
  const rows = await loadJoinedDays(db);

  const raw = FACTORS.map((f) => {
    const strata = buildStrata(rows, f.key);
    return { f, res: stratifiedMeanDiff(strata) };
  });

  // q-values only over factors that actually produced a p-value.
  const testable = raw.filter((r) => r.res.p !== null);
  const qs = benjaminiHochberg(testable.map((r) => r.res.p!));
  const qByFactor = new Map(testable.map((r, i) => [r.f.key, qs[i]]));

  const factors: FactorResult[] = raw.map(({ f, res }) => {
    const powered =
      res.n_cases >= MIN_CASES &&
      res.n_controls >= MIN_CONTROLS &&
      res.strata_used >= MIN_STRATA;
    const q = qByFactor.get(f.key) ?? null;
    // Gate on the ADJUSTED effect. Gating on the unadjusted Cohen's d would let a
    // confound sail through: stratifying can drive the difference to zero while the
    // naive effect size stays enormous.
    const d = res.adjusted_cohens_d;

    let verdict: Verdict;
    if (!powered || res.p === null || d === null) verdict = "insufficient data";
    else if (q !== null && q < 0.05 && Math.abs(d) >= MIN_EFFECT)
      verdict = "possible association";
    else verdict = "no evidence of association";

    return {
      factor: f.key,
      label: f.label,
      n_headache_days: res.n_cases,
      n_control_days: res.n_controls,
      strata_used: res.strata_used,
      unadjusted_diff: round(res.unadjusted_diff, 3),
      adjusted_diff: round(res.adjusted_diff, 3),
      ci_low: round(res.ci_low, 3),
      ci_high: round(res.ci_high, 3),
      unadjusted_cohens_d: round(res.unadjusted_cohens_d, 3),
      adjusted_cohens_d: round(d, 3),
      p: round(res.p, 4),
      q: round(q, 4),
      verdict,
    };
  });

  const enough = factors.some((f) => f.verdict !== "insufficient data");
  const hits = factors.filter((f) => f.verdict === "possible association");

  return {
    method:
      "Case-control on calendar days. Each stratum is one (place, month); only within-stratum differences are pooled by inverse variance, so season and country cannot masquerade as a trigger. Benjamini-Hochberg q-values control the false discovery rate across every factor that has data.",
    excluded:
      "Days within 2 days of a location change, where the weather may belong to the wrong place.",
    thresholds: {
      min_headache_days: MIN_CASES,
      min_control_days: MIN_CONTROLS,
      min_strata: MIN_STRATA,
      max_q: 0.05,
      min_abs_cohens_d: MIN_EFFECT,
    },
    enough_data: enough,
    factors,
    interpretation: hits.length
      ? `${hits.length} factor(s) show a possible association. This is an association on observational data, not a cause. It is not medical advice.`
      : "No factor shows evidence of an association at these thresholds. That is a real result, not a failure: it means these weather variables do not explain her headache days.",
  };
}

// ── F10: belief versus data ──────────────────────────────────────────────────

export interface BeliefResult {
  trigger: string;
  tagged_headache_days: number;
  comparison: {
    factor: FactorKey;
    diff_vs_other_headache_days: number | null;
    ci_low: number | null;
    ci_high: number | null;
    p: number | null;
    /** Benjamini-Hochberg across every tag tested. Never read `p` on its own. */
    q: number | null;
    /** How many (place, month) strata contributed. A result resting on 2 is fragile. */
    strata_used: number;
    verdict: Verdict;
  } | null;
}

/**
 * Her self-reported trigger tags, held to the same standard as everything else.
 *
 * The honest limitation, stated up front: she only ever recorded these tags on days
 * she had a headache. There is no control group for "Stress", so no analysis in the
 * world can say stress causes her migraines from this data. What CAN be asked is a
 * narrower question: do the days she blamed on X look meteorologically different
 * from her other headache days? A yes would suggest the tag is partly tracking the
 * weather rather than the thing she named.
 */
export async function beliefVsData(db: D1Database): Promise<{
  limitation: string;
  what_would_make_it_testable: string;
  what_this_comparison_actually_asks: string;
  tags: BeliefResult[];
}> {
  const rows = await db
    .prepare(
      `SELECT e.local_date, e.self_reported_triggers AS tags,
              d.pressure_delta_24h, d.place
         FROM episodes e
         LEFT JOIN days d ON d.local_date = e.local_date AND d.near_location_boundary = 0
        WHERE e.self_reported_triggers IS NOT NULL AND e.self_reported_triggers <> ''`
    )
    .all<{
      local_date: string;
      tags: string;
      pressure_delta_24h: number | null;
      place: string | null;
    }>();

  const counts = new Map<string, number>();
  for (const r of rows.results) {
    for (const t of r.tags.split(";").map((s) => s.trim()).filter(Boolean)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }

  const sortedTags = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // First pass: compute every comparison, so the multiple-comparison correction
  // can see all of them. Testing 13 tags and reading raw p-values would make one
  // of them "significant" by chance, and that one would be the one believed.
  const computed = sortedTags.map(([tag, n]) => {
    if (n < MIN_TAGGED_DAYS) return { tag, n, res: null };
    const map = new Map<string, Stratum>();
    for (const r of rows.results) {
      const v = r.pressure_delta_24h;
      if (typeof v !== "number") continue;
      const key = `${r.place ?? "?"}|${r.local_date.slice(0, 7)}`;
      let s = map.get(key);
      if (!s) {
        s = { key, cases: [], controls: [] };
        map.set(key, s);
      }
      const tagged = r.tags.split(";").map((x) => x.trim()).includes(tag);
      (tagged ? s.cases : s.controls).push(v);
    }
    const res = stratifiedMeanDiff([...map.values()]);
    return { tag, n, res: res.p !== null ? res : null };
  });

  const testable = computed.filter((c) => c.res !== null);
  const qs = benjaminiHochberg(testable.map((c) => c.res!.p!));
  const qByTag = new Map(testable.map((c, i) => [c.tag, qs[i]]));

  const tags: BeliefResult[] = computed.map(({ tag, n, res }) => {
    if (!res) return { trigger: tag, tagged_headache_days: n, comparison: null };
    const q = qByTag.get(tag) ?? null;
    const d = res.adjusted_cohens_d;
    const verdict: Verdict =
      d === null
        ? "insufficient data"
        : q !== null && q < 0.05 && Math.abs(d) >= MIN_EFFECT
          ? "possible association"
          : "no evidence of association";
    return {
      trigger: tag,
      tagged_headache_days: n,
      comparison: {
        factor: "pressure_delta_24h",
        diff_vs_other_headache_days: round(res.adjusted_diff, 3),
        ci_low: round(res.ci_low, 3),
        ci_high: round(res.ci_high, 3),
        p: round(res.p, 4),
        q: round(q, 4),
        strata_used: res.strata_used,
        verdict,
      },
    };
  });

  return {
    limitation:
      "These tags were recorded ONLY on days she had a headache. There is no control group for them, so this data cannot show that sleep, stress or a late meal causes her migraines, no matter how often they appear. Frequency here measures what she believed and wrote down, not what happened to her.",
    what_would_make_it_testable:
      "Record the factor on EVERY day, not just headache days. Sleep, steps and heart-rate variability can come from Health Connect without her typing anything, exactly as the weather already does. Then each becomes a real case-control comparison.",
    what_this_comparison_actually_asks:
      "Only this: among her headache days, do the ones she blamed on a given tag have different weather from the rest? A 'possible association' would suggest the tag is partly tracking the weather rather than the thing she named. It says nothing about whether the tag causes headaches, because every day here already has one.",
    tags,
  };
}

// ── F20: premonition conversion ──────────────────────────────────────────────

/**
 * "Felt it, got one" versus "felt it, got nothing".
 *
 * This is the cleanest experiment available, and it exists only because she logs
 * her false alarms. Both groups already share whatever produces the feeling, so
 * whatever differs between them is a far stronger candidate for what converts a
 * warning into an attack than anything attack-days-vs-normal-days can offer.
 */
export async function premonitionConversion(
  db: D1Database,
  windowHours = 24
): Promise<{
  enough_data: boolean;
  followed: number;
  not_followed: number;
  note: string;
  factors: Array<{ factor: FactorKey; diff: number | null; ci_low: number | null; ci_high: number | null; p: number | null }>;
}> {
  const windowDays = windowHours / 24;
  const cols = FACTORS.map((f) => `d.${f.key}`).join(", ");

  const rows = await db
    .prepare(
      `SELECT p.id, p.local_date, d.place, ${cols},
              EXISTS (
                SELECT 1 FROM episodes e
                 WHERE e.started_at_time_known = 1
                   AND julianday(e.started_at) > julianday(p.felt_at)
                   AND julianday(e.started_at) <= julianday(p.felt_at) + ?
              ) AS followed
         FROM premonitions p
         LEFT JOIN days d ON d.local_date = p.local_date AND d.near_location_boundary = 0`
    )
    .bind(windowDays)
    .all<Record<string, number | string | null>>();

  const followed = rows.results.filter((r) => r.followed).length;
  const notFollowed = rows.results.length - followed;
  const enough = followed >= 10 && notFollowed >= 10;

  const factors = FACTORS.map((f) => {
    if (!enough) return { factor: f.key, diff: null, ci_low: null, ci_high: null, p: null };
    const map = new Map<string, Stratum>();
    for (const r of rows.results) {
      const v = r[f.key];
      if (typeof v !== "number") continue;
      const key = `${r.place ?? "?"}|${String(r.local_date).slice(0, 7)}`;
      let s = map.get(key);
      if (!s) {
        s = { key, cases: [], controls: [] };
        map.set(key, s);
      }
      (r.followed ? s.cases : s.controls).push(v);
    }
    const res = stratifiedMeanDiff([...map.values()]);
    return {
      factor: f.key,
      diff: round(res.adjusted_diff, 3),
      ci_low: round(res.ci_low, 3),
      ci_high: round(res.ci_high, 3),
      p: round(res.p, 4),
    };
  });

  return {
    enough_data: enough,
    followed,
    not_followed: notFollowed,
    note: enough
      ? "Comparing the days a premonition converted into a headache against the days it did not. Both groups share whatever produced the feeling, so this is a cleaner contrast than headache days against normal days."
      : `Needs at least 10 premonitions followed by a headache and 10 that were not. Currently ${followed} and ${notFollowed}. Her false alarms are the valuable half; keep logging them.`,
    factors,
  };
}

export interface Bindings_ extends Bindings {}

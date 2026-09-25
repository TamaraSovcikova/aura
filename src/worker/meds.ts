import type { MedDose } from "../shared/types";

// Medication-response analysis: what her logged doses reveal about how well, how
// fast, and how far her acute medication works. Pure counting and medians over the
// two timestamps per dose (taken_at, relief_at) plus the residual level; no test,
// no inference beyond "this is what the doses say".
//
// Rules, matching the rest of Aura:
//  - A dose with no relief recorded is NOT thrown away: it counts against the relief
//    rate (a dose that did nothing is the most clinically interesting kind).
//  - Time-to-relief is only ever computed from doses that actually reached relief;
//    the ones that never did have no defined time and must not be zero-filled.
//  - Below a small floor we return "insufficient data" rather than a shaky median.

const MIN_DOSES = 3; // below this, one dose swings every number: don't pretend

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Minutes between two ISO instants, or null if it is negative/unparseable (a
 *  relief logged before its dose is corrupt, not a zero-minute miracle). */
function minutesBetween(takenAt: string, reliefAt: string): number | null {
  const t = Date.parse(takenAt);
  const r = Date.parse(reliefAt);
  if (!Number.isFinite(t) || !Number.isFinite(r)) return null;
  const mins = (r - t) / 60000;
  return mins >= 0 ? mins : null;
}

export interface MedResponseGroup {
  /** null = across all doses; a string = one named medication. */
  medication: string | null;
  doses: number;
  doses_with_relief: number;
  /** Fraction of doses that reached a recorded relief, 0..1. */
  relief_rate: number;
  /** Median minutes from taking the dose to feeling better (relief doses only). */
  median_minutes_to_relief: number | null;
  /** Median residual pain (0-10) it pulled down to (relief doses that gave a level). */
  median_residual: number | null;
}

export interface MedResponse {
  verdict: "insufficient data" | "summary";
  message: string;
  overall: MedResponseGroup;
  /** Per-medication rows with at least MIN_DOSES doses, most-used first. */
  by_medication: MedResponseGroup[];
}

function summarise(medication: string | null, doses: MedDose[]): MedResponseGroup {
  const withRelief = doses.filter((d) => d.relief_at != null);
  const times = withRelief
    .map((d) => minutesBetween(d.taken_at, d.relief_at as string))
    .filter((m): m is number => m != null);
  const residuals = withRelief
    .map((d) => d.relief_severity)
    .filter((s): s is number => s != null);
  return {
    medication,
    doses: doses.length,
    doses_with_relief: withRelief.length,
    relief_rate: doses.length ? withRelief.length / doses.length : 0,
    median_minutes_to_relief: median(times),
    median_residual: median(residuals),
  };
}

export async function medicationResponse(db: D1Database): Promise<MedResponse> {
  const res = await db
    .prepare(`SELECT * FROM med_doses ORDER BY taken_at ASC`)
    .all<MedDose>();
  const doses = res.results ?? [];

  const overall = summarise(null, doses);

  if (doses.length < MIN_DOSES) {
    return {
      verdict: "insufficient data",
      message: `Only ${doses.length} dose${doses.length === 1 ? "" : "s"} logged so far. A few more, each with an "I feel better" follow-up when it helps, and this can show how fast and how far your medication works.`,
      overall,
      by_medication: [],
    };
  }

  // Group by medication name; unnamed doses don't form their own row (nothing to
  // call them), but they still count in `overall`.
  const groups = new Map<string, MedDose[]>();
  for (const d of doses) {
    if (!d.name) continue;
    const arr = groups.get(d.name) ?? [];
    arr.push(d);
    groups.set(d.name, arr);
  }
  const by_medication = [...groups.entries()]
    .map(([name, ds]) => summarise(name, ds))
    .filter((g) => g.doses >= MIN_DOSES)
    .sort((a, b) => b.doses - a.doses);

  const pct = Math.round(overall.relief_rate * 100);
  const t = overall.median_minutes_to_relief;
  const timePhrase =
    t == null
      ? "no relief times recorded yet"
      : `typically about ${Math.round(t)} min to relief`;
  const residPhrase =
    overall.median_residual == null
      ? ""
      : `, down to around ${overall.median_residual}/10`;

  return {
    verdict: "summary",
    message: `${overall.doses_with_relief} of ${overall.doses} logged doses brought relief (${pct}%), ${timePhrase}${residPhrase}. A dose with no relief logged counts as one that did not help.`,
    overall,
    by_medication,
  };
}

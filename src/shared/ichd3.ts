// F18: ICHD-3 criteria matching for a single attack.
//
// This module reports WHICH published criteria an attack meets. It never states a
// diagnosis. ICHD-3 also requires that the headache is "not better accounted for by
// another diagnosis", which no app can establish, so the ceiling here is
// "meets criteria for ...", handed to a clinician to interpret.
//
// Every criterion has three states, not two: met, not met, and unknown. An attack
// with missing attributes is under-determined, never quietly counted as tension-type.
// The imported diary has almost none of these attributes, so it stays unclassified
// and contributes to headache days, never to migraine days.

/** The attributes a person records after an attack. Any may be null (not recorded). */
export interface AttackAttributes {
  /** 'one' unilateral, 'both' bilateral. Derived from the head map, or set directly. */
  side: "one" | "both" | null;
  quality: "throbbing" | "pressing" | null;
  aggravated_by_activity: boolean | null;
  nausea: boolean | null;
  photophobia: boolean | null;
  phonophobia: boolean | null;
  aura: boolean | null;
  /** Peak pain on the 0-10 VAS. Used only for the moderate/severe criterion. */
  severity: number | null;
  /** Attack length in hours, when both ends are known. Null for imported rows. */
  duration_hours: number | null;
}

export type Ichd3Verdict =
  | "migraine_with_aura"
  | "migraine_without_aura"
  | "probable_migraine"
  | "tension_type_consistent"
  | "unclassified";

/** VAS 6+ is taken as moderate-or-severe. Below the clinical qualitative cut, a lower
 *  number is mild, so this is a defensible mapping rather than a guess. */
const MODERATE_SEVERE = 6;

/** ICHD-3 caps a migraine attack at 4-72h. */
const MIN_HOURS = 4;
const MAX_HOURS = 72;

export interface Ichd3Result {
  verdict: Ichd3Verdict;
  /** The four "C" pain-characteristic criteria: >=2 needed for migraine. */
  criteria: {
    unilateral: boolean | null;
    pulsating: boolean | null;
    moderate_or_severe: boolean | null;
    aggravated_by_activity: boolean | null;
  };
  /** The "D" associated-symptom criterion: nausea/vomiting, or photophobia AND phonophobia. */
  associated_symptom: boolean | null;
  /** How many of the four C criteria are known-met. */
  c_met_count: number;
  /** True only when duration is known AND within 4-72h. Null when duration is unknown. */
  duration_ok: boolean | null;
  /** Plain-English list of the criteria met, for display. Never a diagnosis. */
  met: string[];
  /** Why it could not be classified, when it could not. */
  missing: string[];
}

const countKnown = (vals: Array<boolean | null>) => ({
  met: vals.filter((v) => v === true).length,
  unknown: vals.filter((v) => v === null).length,
});

/**
 * Match one attack against the ICHD-3 criteria for migraine (1.1 without aura,
 * 1.2 with aura) and tension-type (2.x). Returns which criteria are met and a
 * conservative verdict, or "unclassified" when too little was recorded to decide.
 */
export function classifyAttack(a: AttackAttributes): Ichd3Result {
  const criteria = {
    unilateral: a.side === null ? null : a.side === "one",
    pulsating: a.quality === null ? null : a.quality === "throbbing",
    moderate_or_severe: a.severity === null ? null : a.severity >= MODERATE_SEVERE,
    aggravated_by_activity: a.aggravated_by_activity,
  };

  // D criterion: nausea/vomiting, OR photophobia AND phonophobia. If the parts that
  // would make it TRUE are missing, it is unknown rather than false.
  let associated: boolean | null;
  if (a.nausea === true || (a.photophobia === true && a.phonophobia === true)) {
    associated = true;
  } else if (a.nausea === null && (a.photophobia === null || a.phonophobia === null)) {
    associated = null;
  } else {
    associated = false;
  }

  const cVals = [
    criteria.unilateral,
    criteria.pulsating,
    criteria.moderate_or_severe,
    criteria.aggravated_by_activity,
  ];
  const c = countKnown(cVals);

  const durationOk =
    a.duration_hours === null
      ? null
      : a.duration_hours >= MIN_HOURS && a.duration_hours <= MAX_HOURS;

  const met: string[] = [];
  if (criteria.unilateral) met.push("one-sided");
  if (criteria.pulsating) met.push("throbbing");
  if (criteria.moderate_or_severe) met.push("moderate or severe");
  if (criteria.aggravated_by_activity) met.push("worse with activity");
  if (associated === true) {
    if (a.nausea === true) met.push("nausea");
    if (a.photophobia === true && a.phonophobia === true) met.push("light and sound sensitivity");
  }

  // Migraine pain-feature criterion (C): at least two of the four.
  // Associated-symptom criterion (D): met.
  const migraineFeatures = c.met >= 2 && associated === true;

  const missing: string[] = [];
  const result = (verdict: Ichd3Verdict): Ichd3Result => ({
    verdict,
    criteria,
    associated_symptom: associated,
    c_met_count: c.met,
    duration_ok: durationOk,
    met,
    missing,
  });

  // Not enough recorded to say anything: no pain features known and no symptom known.
  if (c.met === 0 && c.unknown === 4 && associated === null) {
    missing.push("no attributes recorded");
    return result("unclassified");
  }

  if (migraineFeatures) {
    // Duration, when known, must be in range; when unknown it does not block the
    // criteria match (it is simply noted as unverified).
    if (durationOk === false) {
      missing.push("duration outside 4-72h");
      return result("unclassified");
    }
    return result(a.aura === true ? "migraine_with_aura" : "migraine_without_aura");
  }

  // Close to migraine but one criterion short of confidence, and nothing rules it out:
  // ICHD-3's "probable migraine" (1.5). Only when the shortfall is missing data, not
  // a criterion known to fail.
  if (c.met >= 2 && associated === null) {
    missing.push("nausea / light-sound sensitivity not recorded");
    return result("probable_migraine");
  }
  if (c.met === 1 && c.unknown >= 1 && associated === true) {
    missing.push("only one pain feature recorded");
    return result("probable_migraine");
  }

  // Tension-type is only asserted when its criteria are POSITIVELY met: bilateral,
  // pressing, not aggravated, and no migraine-associated symptoms. Never a fallback.
  const tension =
    criteria.unilateral === false &&
    criteria.pulsating === false &&
    criteria.aggravated_by_activity === false &&
    associated === false;
  if (tension) return result("tension_type_consistent");

  missing.push("attributes recorded do not match a full criteria set");
  return result("unclassified");
}

/** Whether a verdict counts toward Monthly Migraine Days. Probable does not: MMD is
 *  the number a neurologist reads for treatment response, so it stays strict. */
export function isMigraine(v: Ichd3Verdict): boolean {
  return v === "migraine_with_aura" || v === "migraine_without_aura";
}

// ── Row → attributes, shared by the summary and the exports ──────────────────
//
// Both the dashboard (insights.ts) and the doctor/Obsidian exports (export.ts)
// classify episode rows. This mapping lives here, once, so the two can never
// report a different migraine count for the same attack.

/** Coerce a nullable DB cell (0/1/null) to a tri-state boolean: null means the
 *  attribute was never recorded, which the classifier treats as unknown. */
export const boolOrNull = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

/** True when a row carries at least one ICHD-3 attribute, so it is worth
 *  classifying. A row with none stays a headache day, never a migraine day. */
export function hasAnyAttribute(r: Record<string, unknown>): boolean {
  return (
    r.side != null ||
    r.quality != null ||
    r.aggravated_by_activity != null ||
    r.nausea != null ||
    r.photophobia != null ||
    r.phonophobia != null ||
    r.aura != null
  );
}

/** Build the classifier's input from an episodes row. Duration is derived from
 *  started_at/ended_at only when both are present (imported rows have no end). */
export function rowToAttackAttributes(r: Record<string, unknown>): AttackAttributes {
  const start = r.started_at as string | null;
  const end = r.ended_at as string | null;
  return {
    side: (r.side as "one" | "both" | null) ?? null,
    quality: (r.quality as "throbbing" | "pressing" | null) ?? null,
    aggravated_by_activity: boolOrNull(r.aggravated_by_activity),
    nausea: boolOrNull(r.nausea),
    photophobia: boolOrNull(r.photophobia),
    phonophobia: boolOrNull(r.phonophobia),
    aura: boolOrNull(r.aura),
    severity: (r.severity as number | null) ?? null,
    duration_hours: start && end ? (Date.parse(end) - Date.parse(start)) / 3600000 : null,
  };
}

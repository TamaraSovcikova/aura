// Statistics for the trigger engine. Pure, no I/O, fully tested.
//
// The guiding rule: it is far better to say "not enough data" than to report a
// plausible association that does not exist. Someone reads these numbers about
// their own health and changes their life around them.

export const mean = (a: number[]): number =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

/** Sample variance (Bessel-corrected). NaN for n < 2. */
export const variance = (a: number[]): number => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
};

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normalCdf(z: number): number {
  const s = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}

/** Two-sided p-value for a z statistic. */
export const twoSidedP = (z: number): number =>
  Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));

/**
 * Benjamini-Hochberg FDR. Returns q-values in the input order.
 *
 * Seven factors are tested at once. Without this, one in twenty would look
 * "significant" by chance alone, and that one would be the one that gets believed.
 */
export function benjaminiHochberg(pvals: number[]): number[] {
  const n = pvals.length;
  if (n === 0) return [];
  const idx = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(n);
  let prev = 1;
  for (let k = n - 1; k >= 0; k--) {
    const val = Math.min(prev, (idx[k].p * n) / (k + 1));
    q[idx[k].i] = Math.min(1, val);
    prev = val;
  }
  return q;
}

/** Standardized effect size (Cohen's d, pooled SD). */
export function cohensD(caseVals: number[], controlVals: number[]): number {
  const n1 = caseVals.length;
  const n2 = controlVals.length;
  if (n1 < 2 || n2 < 2) return NaN;
  const v1 = variance(caseVals);
  const v2 = variance(controlVals);
  const sp = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  if (!Number.isFinite(sp) || sp === 0) return NaN;
  return (mean(caseVals) - mean(controlVals)) / sp;
}

export interface Stratum {
  key: string;
  cases: number[];
  controls: number[];
}

export interface StratifiedResult {
  n_cases: number;
  n_controls: number;
  strata_used: number;
  /** Naive difference ignoring strata. Kept only to show what stratifying changed. */
  unadjusted_diff: number | null;
  /** Inverse-variance pooled within-stratum difference (cases minus controls). */
  adjusted_diff: number | null;
  se: number | null;
  ci_low: number | null;
  ci_high: number | null;
  z: number | null;
  p: number | null;
  /** Cohen's d on the pooled data. CONFOUNDED whenever the strata differ. */
  unadjusted_cohens_d: number | null;
  /** Pooled within-stratum SD: the scale on which the adjusted effect is measured. */
  within_sd: number | null;
  /**
   * Standardized ADJUSTED effect. This is the one to gate on. Gating on the
   * unadjusted d lets a confound sail through: stratifying can drive the
   * difference to zero while the naive effect size stays enormous.
   */
  adjusted_cohens_d: number | null;
}

/**
 * Inverse-variance pooled difference in means, stratified.
 *
 * Barometric pressure differs systematically by country and by season. Comparing a
 * Slovak August against a British January would attribute the weather of a holiday
 * to a headache. Each stratum here is one (place, month), so every comparison is
 * made between days that are alike in the ways we already know matter, and only the
 * within-stratum differences are pooled.
 *
 * A stratum contributes only if it has at least 2 cases and 2 controls (a variance
 * needs both).
 */
export function stratifiedMeanDiff(strata: Stratum[]): StratifiedResult {
  const allCases = strata.flatMap((s) => s.cases);
  const allControls = strata.flatMap((s) => s.controls);

  let wSum = 0;
  let wdSum = 0;
  let used = 0;
  // Sample-size-weighted mean of the within-stratum pooled variances.
  let nSum = 0;
  let nVarSum = 0;

  for (const s of strata) {
    const n1 = s.cases.length;
    const n2 = s.controls.length;
    if (n1 < 2 || n2 < 2) continue;
    const v1 = variance(s.cases);
    const v2 = variance(s.controls);
    const se2 = v1 / n1 + v2 / n2; // Welch variance of the difference
    if (!Number.isFinite(se2) || se2 <= 0) continue;
    const d = mean(s.cases) - mean(s.controls);
    const w = 1 / se2;
    wSum += w;
    wdSum += w * d;
    used++;

    const sp2 = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
    if (Number.isFinite(sp2)) {
      nSum += n1 + n2;
      nVarSum += (n1 + n2) * sp2;
    }
  }

  const base: StratifiedResult = {
    n_cases: allCases.length,
    n_controls: allControls.length,
    strata_used: used,
    unadjusted_diff:
      allCases.length && allControls.length
        ? mean(allCases) - mean(allControls)
        : null,
    adjusted_diff: null,
    se: null,
    ci_low: null,
    ci_high: null,
    z: null,
    p: null,
    unadjusted_cohens_d:
      allCases.length >= 2 && allControls.length >= 2
        ? cohensD(allCases, allControls)
        : null,
    within_sd: null,
    adjusted_cohens_d: null,
  };

  if (used === 0 || wSum === 0) return base;

  const diff = wdSum / wSum;
  const se = Math.sqrt(1 / wSum);
  const z = diff / se;
  const withinSd = nSum > 0 ? Math.sqrt(nVarSum / nSum) : null;

  return {
    ...base,
    adjusted_diff: diff,
    se,
    ci_low: diff - 1.96 * se,
    ci_high: diff + 1.96 * se,
    z,
    p: twoSidedP(z),
    within_sd: withinSd,
    adjusted_cohens_d:
      withinSd !== null && withinSd > 0 && Number.isFinite(withinSd)
        ? diff / withinSd
        : null,
  };
}

export const round = (v: number | null, dp = 4): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

/** A 2x2 table within one stratum. */
export interface Table2x2 {
  key: string;
  /** exposed and had a headache */ a: number;
  /** exposed, no headache */ b: number;
  /** unexposed and had a headache */ c: number;
  /** unexposed, no headache */ d: number;
}

export interface OddsRatioResult {
  strata_used: number;
  exposed_days: number;
  unexposed_days: number;
  exposed_headache_days: number;
  unexposed_headache_days: number;
  /** Ignores strata. Kept only to show what stratifying changed. */
  crude_or: number | null;
  /** Mantel-Haenszel pooled odds ratio. */
  or: number | null;
  ci_low: number | null;
  ci_high: number | null;
  p: number | null;
}

/**
 * Mantel-Haenszel odds ratio with a Robins-Breslow-Greenland variance.
 *
 * A menstrual window is a BINARY exposure, not a quantity. Feeding it to a
 * difference-in-means test would be meaningless. This compares the ODDS of a
 * headache inside the window against outside it, pooled across strata so season
 * and country cannot leak in, exactly as the continuous factors are.
 *
 * A stratum contributes only if it contains at least one exposed and one
 * unexposed day; a table with an empty margin carries no information about the
 * ratio and would only add noise.
 */
export function mantelHaenszelOR(tables: Table2x2[]): OddsRatioResult {
  let sumR = 0;
  let sumS = 0;
  let vNum1 = 0;
  let vNum2 = 0;
  let vNum3 = 0;
  let used = 0;

  let A = 0;
  let B = 0;
  let C = 0;
  let D = 0;

  for (const t of tables) {
    const n = t.a + t.b + t.c + t.d;
    if (n === 0) continue;
    A += t.a;
    B += t.b;
    C += t.c;
    D += t.d;

    const exposed = t.a + t.b;
    const unexposed = t.c + t.d;
    if (exposed === 0 || unexposed === 0) continue;

    const R = (t.a * t.d) / n;
    const S = (t.b * t.c) / n;
    const P = (t.a + t.d) / n;
    const Q = (t.b + t.c) / n;

    sumR += R;
    sumS += S;
    vNum1 += P * R;
    vNum2 += P * S + Q * R;
    vNum3 += Q * S;
    used++;
  }

  const crude = B * C > 0 ? (A * D) / (B * C) : null;

  const base: OddsRatioResult = {
    strata_used: used,
    exposed_days: A + B,
    unexposed_days: C + D,
    exposed_headache_days: A,
    unexposed_headache_days: C,
    crude_or: crude,
    or: null,
    ci_low: null,
    ci_high: null,
    p: null,
  };

  if (used === 0 || sumR === 0 || sumS === 0) return base;

  const or = sumR / sumS;
  const varLn =
    vNum1 / (2 * sumR * sumR) + vNum2 / (2 * sumR * sumS) + vNum3 / (2 * sumS * sumS);
  if (!Number.isFinite(varLn) || varLn <= 0) return { ...base, or };

  const se = Math.sqrt(varLn);
  const lnOr = Math.log(or);
  return {
    ...base,
    or,
    ci_low: Math.exp(lnOr - 1.96 * se),
    ci_high: Math.exp(lnOr + 1.96 * se),
    p: twoSidedP(lnOr / se),
  };
}

// ── Categorical + circular tests (day-of-week and time-of-day patterns) ──────

/** Upper-tail chi-square p-value via the Wilson-Hilferty normal approximation.
 *  Accurate to a few decimals for df >= 1 and avoids shipping an incomplete-gamma. */
export function chiSquarePValue(chi2: number, df: number): number {
  if (chi2 <= 0 || df <= 0) return 1;
  const t = Math.cbrt(chi2 / df);
  const m = 1 - 2 / (9 * df);
  const s = Math.sqrt(2 / (9 * df));
  return Math.min(1, Math.max(0, 1 - normalCdf((t - m) / s)));
}

export interface Contingency {
  chi2: number;
  df: number;
  p: number;
  /** Smallest expected cell count. Chi-square is unreliable below ~5. */
  min_expected: number;
}

/** Chi-square test of independence on an R×C contingency table. */
export function chiSquareContingency(rows: number[][]): Contingency {
  const R = rows.length;
  const C = rows[0]?.length ?? 0;
  const rowTot = rows.map((r) => r.reduce((a, b) => a + b, 0));
  const colTot = Array.from({ length: C }, (_, j) => rows.reduce((a, r) => a + r[j], 0));
  const grand = rowTot.reduce((a, b) => a + b, 0);
  let chi2 = 0;
  let minE = Infinity;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) {
      const E = grand ? (rowTot[i] * colTot[j]) / grand : 0;
      minE = Math.min(minE, E);
      if (E > 0) chi2 += (rows[i][j] - E) ** 2 / E;
    }
  }
  const df = Math.max(1, (R - 1) * (C - 1));
  return { chi2, df, p: chiSquarePValue(chi2, df), min_expected: minE === Infinity ? 0 : minE };
}

export interface RayleighResult {
  n: number;
  /** Mean direction in radians; NaN when n = 0. */
  mean_angle: number;
  /** Mean resultant length, 0 (uniform) to 1 (all identical). */
  resultant: number;
  z: number;
  p: number;
}

/**
 * Rayleigh test for a preferred direction on a circle. Time of day is circular
 * (23:00 is close to 01:00), so a bin-and-chi-square would mis-handle the wrap;
 * this tests directly whether onset times cluster around any hour. Angles are in
 * radians (hour / 24 * 2π). Uses Zar's small-sample p-value correction.
 */
export function rayleighTest(anglesRad: number[]): RayleighResult {
  const n = anglesRad.length;
  if (n === 0) return { n: 0, mean_angle: NaN, resultant: 0, z: 0, p: 1 };
  let C = 0;
  let S = 0;
  for (const a of anglesRad) {
    C += Math.cos(a);
    S += Math.sin(a);
  }
  const resultant = Math.sqrt(C * C + S * S) / n;
  const z = n * resultant * resultant;
  const p =
    Math.exp(-z) *
    (1 + (2 * z - z * z) / (4 * n) - (24 * z - 132 * z * z + 76 * z ** 3 - 9 * z ** 4) / (288 * n * n));
  return { n, mean_angle: Math.atan2(S, C), resultant, z, p: Math.min(1, Math.max(0, p)) };
}

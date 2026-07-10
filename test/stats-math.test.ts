import { describe, it, expect } from "vitest";
import {
  benjaminiHochberg,
  cohensD,
  mean,
  normalCdf,
  stratifiedMeanDiff,
  twoSidedP,
  variance,
  type Stratum,
} from "../src/shared/stats";

describe("normalCdf", () => {
  it("matches known values of the standard normal", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 5);
    expect(normalCdf(3)).toBeCloseTo(0.9986501, 5);
  });

  it("is symmetric", () => {
    for (const z of [0.3, 1.1, 2.7]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6);
    }
  });
});

describe("twoSidedP", () => {
  it("gives the textbook p-values", () => {
    expect(twoSidedP(1.959964)).toBeCloseTo(0.05, 4);
    expect(twoSidedP(0)).toBeCloseTo(1, 6);
    expect(twoSidedP(2.575829)).toBeCloseTo(0.01, 3);
  });
});

describe("variance and mean", () => {
  it("uses the Bessel-corrected sample variance", () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.5714286, 6);
  });

  it("is NaN for a single observation", () => {
    expect(Number.isNaN(variance([1]))).toBe(true);
  });
});

describe("cohensD", () => {
  it("computes a standardized difference", () => {
    // Two groups, same SD, means 1 apart.
    const a = [2, 3, 4, 5, 6];
    const b = [1, 2, 3, 4, 5];
    expect(cohensD(a, b)).toBeCloseTo(1 / Math.sqrt(2.5), 5);
  });

  it("is NaN when a group has no spread", () => {
    expect(Number.isNaN(cohensD([1, 1, 1], [1, 1, 1]))).toBe(true);
  });
});

describe("benjaminiHochberg", () => {
  it("controls the false discovery rate across the factor set", () => {
    // Classic worked example.
    const p = [0.01, 0.02, 0.03, 0.04, 0.05];
    const q = benjaminiHochberg(p);
    expect(q[0]).toBeCloseTo(0.05, 6);
    expect(q[4]).toBeCloseTo(0.05, 6);
    // q-values are monotone in p.
    for (let i = 1; i < q.length; i++) expect(q[i]).toBeGreaterThanOrEqual(q[i - 1] - 1e-12);
  });

  it("keeps the input order", () => {
    const q = benjaminiHochberg([0.5, 0.001]);
    expect(q[1]).toBeLessThan(q[0]);
  });

  it("never returns a q above 1", () => {
    expect(benjaminiHochberg([0.9, 0.95]).every((q) => q <= 1)).toBe(true);
  });

  it("handles the empty set", () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe("stratifiedMeanDiff", () => {
  it("reduces to a Welch comparison with one stratum", () => {
    const s: Stratum[] = [{ key: "a", cases: [10, 12, 14], controls: [4, 6, 8] }];
    const r = stratifiedMeanDiff(s);
    expect(r.strata_used).toBe(1);
    expect(r.adjusted_diff).toBeCloseTo(6, 6);
    // Welch SE: sqrt(v1/n1 + v2/n2) = sqrt(4/3 + 4/3)
    expect(r.se!).toBeCloseTo(Math.sqrt(8 / 3), 6);
  });

  it("removes a confound that the unadjusted difference invents", () => {
    // Two strata (think: Slovak summer, British winter). Within each stratum the
    // cases and controls are IDENTICAL, so the true effect is zero. But cases are
    // concentrated in the high-pressure stratum, so the naive difference is large.
    const s: Stratum[] = [
      { key: "summer-SK", cases: [1020, 1020, 1020, 1020], controls: [1020, 1020] },
      { key: "winter-UK", cases: [1000, 1000], controls: [1000, 1000, 1000, 1000] },
    ];
    const r = stratifiedMeanDiff(s);
    expect(r.unadjusted_diff).toBeGreaterThan(5); // the lie
    expect(r.adjusted_diff).toBeCloseTo(0, 6); // the truth
  });

  it("ignores a stratum too thin to have a variance", () => {
    const s: Stratum[] = [
      { key: "thin", cases: [5], controls: [1] },
      { key: "usable", cases: [10, 12], controls: [4, 6] },
    ];
    const r = stratifiedMeanDiff(s);
    expect(r.strata_used).toBe(1);
    expect(r.adjusted_diff).toBeCloseTo(6, 6);
  });

  it("reports no pooled estimate when every stratum is too thin", () => {
    const r = stratifiedMeanDiff([{ key: "x", cases: [1], controls: [2] }]);
    expect(r.strata_used).toBe(0);
    expect(r.adjusted_diff).toBeNull();
    expect(r.p).toBeNull();
    expect(r.n_cases).toBe(1); // counts still reported
  });

  it("gives a confidence interval that brackets the estimate", () => {
    const s: Stratum[] = [{ key: "a", cases: [10, 12, 14], controls: [4, 6, 8] }];
    const r = stratifiedMeanDiff(s);
    expect(r.ci_low!).toBeLessThan(r.adjusted_diff!);
    expect(r.ci_high!).toBeGreaterThan(r.adjusted_diff!);
    expect(r.ci_high! - r.ci_low!).toBeCloseTo(2 * 1.96 * r.se!, 6);
  });

  it("finds no signal when cases and controls come from the same distribution", () => {
    // Deterministic pseudo-random so the test cannot flake.
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const strata: Stratum[] = [];
    for (let k = 0; k < 8; k++) {
      strata.push({
        key: `s${k}`,
        cases: Array.from({ length: 20 }, () => rnd() * 10),
        controls: Array.from({ length: 40 }, () => rnd() * 10),
      });
    }
    const r = stratifiedMeanDiff(strata);
    expect(Math.abs(r.adjusted_diff!)).toBeLessThan(0.6);
    expect(r.p!).toBeGreaterThan(0.05); // must not cry wolf
  });
});

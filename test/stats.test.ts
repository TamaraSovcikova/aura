import { describe, it, expect } from "vitest";
import { monthSeries, headacheDaysTrend, type MonthRow } from "../src/worker/stats";

const m = (month: string, headache_days: number): MonthRow => ({
  month,
  headache_days,
  avg_severity: null,
});

describe("monthSeries", () => {
  it("includes a month with zero headache days instead of dropping it", () => {
    // A GROUP BY omits empty months. That month is the best possible outcome,
    // and dropping it would inflate every average.
    const s = monthSeries([m("2025-01", 5), m("2025-03", 3)], "2025-01-01", "2025-03-31");
    expect(s.map((x) => [x.month, x.headache_days])).toEqual([
      ["2025-01", 5],
      ["2025-02", 0],
      ["2025-03", 3],
    ]);
  });

  it("marks the first month partial when logging started mid-month", () => {
    const s = monthSeries([m("2024-08", 3)], "2024-08-26", "2024-09-30");
    expect(s[0]).toMatchObject({ month: "2024-08", complete: false });
    expect(s[1]).toMatchObject({ month: "2024-09", complete: true });
  });

  it("marks the current, still-running month partial", () => {
    const s = monthSeries([m("2026-06", 4), m("2026-07", 2)], "2026-06-01", "2026-07-10");
    expect(s.find((x) => x.month === "2026-06")!.complete).toBe(true);
    expect(s.find((x) => x.month === "2026-07")!.complete).toBe(false);
  });

  it("handles a December to January rollover", () => {
    const s = monthSeries([m("2025-12", 1)], "2025-12-01", "2026-01-31");
    expect(s.map((x) => x.month)).toEqual(["2025-12", "2026-01"]);
  });
});

describe("headacheDaysTrend", () => {
  it("never compares a part-month against full months", () => {
    // A realistic shape: busy months, then a quiet June, then 3 days of July.
    // Including July fabricates a >=50% reduction, the clinical threshold for a
    // treatment response, which would be wrong.
    const rows = [
      m("2026-01", 10), m("2026-02", 12), m("2026-03", 11),
      m("2026-04", 12), m("2026-05", 10), m("2026-06", 6),
      m("2026-07", 2), // only 3 days observed
    ];
    const series = monthSeries(rows, "2026-01-01", "2026-07-03");
    const t = headacheDaysTrend(series) as Record<string, unknown>;

    expect(t.excluded_partial_months).toEqual(["2026-07"]);
    expect(t.recent_3_months).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(t.prior_3_months).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(t.recent_mean_headache_days).toBe(9.3);
    expect(t.prior_mean_headache_days).toBe(11);
    expect(t.meets_50pct_reduction).toBe(false);
  });

  it("refuses to trend without 6 complete months", () => {
    const series = monthSeries([m("2026-01", 5)], "2026-01-01", "2026-02-10");
    const t = headacheDaysTrend(series) as Record<string, unknown>;
    expect(t.enough_data).toBe(false);
  });

  it("reports a genuine halving as a 50% reduction", () => {
    const rows = [
      m("2026-01", 12), m("2026-02", 12), m("2026-03", 12),
      m("2026-04", 6), m("2026-05", 6), m("2026-06", 6),
    ];
    const series = monthSeries(rows, "2026-01-01", "2026-06-30");
    const t = headacheDaysTrend(series) as Record<string, unknown>;
    expect(t.percent_change).toBe(-50);
    expect(t.meets_50pct_reduction).toBe(true);
  });

  it("counts a migraine-free month as a real zero, not a gap", () => {
    const rows = [
      m("2026-01", 10), m("2026-02", 10), m("2026-03", 10),
      m("2026-04", 0), m("2026-05", 0), m("2026-06", 0), // absent from GROUP BY
    ];
    const present = rows.filter((r) => r.headache_days > 0);
    const series = monthSeries(present, "2026-01-01", "2026-06-30");
    const t = headacheDaysTrend(series) as Record<string, unknown>;
    expect(t.recent_mean_headache_days).toBe(0);
    expect(t.percent_change).toBe(-100);
  });
});

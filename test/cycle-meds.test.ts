import { describe, it, expect } from "vitest";
import { mantelHaenszelOR, type Table2x2 } from "../src/shared/stats";
import { cycleContext, normalizeStarts } from "../src/shared/cycle";
import { classifyMed, medicationDays } from "../src/shared/meds";

describe("mantelHaenszelOR", () => {
  it("recovers a known odds ratio from a single table", () => {
    // a=10 exposed cases, b=20 exposed controls, c=5 unexposed cases, d=40 controls
    // OR = (10*40)/(20*5) = 4
    const r = mantelHaenszelOR([{ key: "s", a: 10, b: 20, c: 5, d: 40 }]);
    expect(r.or).toBeCloseTo(4, 6);
    expect(r.crude_or).toBeCloseTo(4, 6);
    expect(r.ci_low!).toBeLessThan(4);
    expect(r.ci_high!).toBeGreaterThan(4);
    expect(r.p!).toBeLessThan(0.05);
  });

  it("pools identical strata to the same ratio", () => {
    const t: Table2x2 = { key: "a", a: 10, b: 20, c: 5, d: 40 };
    const r = mantelHaenszelOR([t, { ...t, key: "b" }]);
    expect(r.or).toBeCloseTo(4, 6);
    expect(r.strata_used).toBe(2);
    expect(r.exposed_days).toBe(60);
  });

  it("removes a confound that the crude odds ratio invents", () => {
    // Within each stratum the odds are IDENTICAL (OR = 1). But exposure and
    // headaches both cluster in stratum 1, so the crude ratio looks like a signal.
    const tables: Table2x2[] = [
      { key: "high-risk", a: 40, b: 40, c: 5, d: 5 }, // OR = 1
      { key: "low-risk", a: 5, b: 45, c: 5, d: 45 }, // OR = 1
    ];
    const r = mantelHaenszelOR(tables);
    expect(r.crude_or!).toBeGreaterThan(1.5); // the lie
    expect(r.or).toBeCloseTo(1, 6); // the truth
    expect(r.p!).toBeGreaterThan(0.05);
  });

  it("ignores a stratum with an empty exposure margin", () => {
    const r = mantelHaenszelOR([
      { key: "no-exposed", a: 0, b: 0, c: 10, d: 10 },
      { key: "usable", a: 10, b: 20, c: 5, d: 40 },
    ]);
    expect(r.strata_used).toBe(1);
    expect(r.or).toBeCloseTo(4, 6);
  });

  it("reports counts but no ratio when nothing is estimable", () => {
    const r = mantelHaenszelOR([{ key: "x", a: 0, b: 0, c: 5, d: 5 }]);
    expect(r.or).toBeNull();
    expect(r.p).toBeNull();
    expect(r.unexposed_days).toBe(10);
  });
});

describe("cycleContext", () => {
  const starts = normalizeStarts(["2026-03-01", "2026-03-29", "2026-04-26"]);

  it("counts day 1 from the day the period started", () => {
    expect(cycleContext("2026-03-01", starts).cycle_day).toBe(1);
    expect(cycleContext("2026-03-10", starts).cycle_day).toBe(10);
  });

  it("marks the perimenstrual window as day -2 to +3", () => {
    expect(cycleContext("2026-03-01", starts).perimenstrual).toBe(true); // day 1
    expect(cycleContext("2026-03-03", starts).perimenstrual).toBe(true); // day 3
    expect(cycleContext("2026-03-04", starts).perimenstrual).toBe(false); // day 4
    expect(cycleContext("2026-03-27", starts).perimenstrual).toBe(true); // 2 days before next
    expect(cycleContext("2026-03-26", starts).perimenstrual).toBe(false); // 3 days before
  });

  it("knows nothing before the first logged period", () => {
    expect(cycleContext("2026-02-20", starts)).toEqual({
      cycle_day: null,
      days_to_next_start: null,
      perimenstrual: null,
    });
  });

  it("refuses to guess across a missed log", () => {
    // A 60-day gap is a forgotten entry, not a 60-day cycle.
    const gappy = normalizeStarts(["2026-01-01", "2026-03-10"]);
    expect(cycleContext("2026-02-01", gappy).cycle_day).toBeNull();
  });

  it("will not call a day 'not perimenstrual' when the next period is unknown", () => {
    // After the last logged start we cannot know the next one is not imminent.
    const c = cycleContext("2026-05-10", starts); // 14 days after 2026-04-26
    expect(c.cycle_day).toBe(15);
    expect(c.days_to_next_start).toBeNull();
    expect(c.perimenstrual).toBeNull(); // not `false`
  });

  it("goes silent once past a plausible cycle beyond the last start", () => {
    expect(cycleContext("2026-07-01", starts).cycle_day).toBeNull();
  });
});

describe("classifyMed", () => {
  it("recognises triptans, including brand names", () => {
    expect(classifyMed("sumatriptan 50mg")).toBe("triptan");
    expect(classifyMed("Imigran")).toBe("triptan");
    expect(classifyMed("rizatriptan")).toBe("triptan");
  });

  it("recognises simple analgesics", () => {
    expect(classifyMed("ibuprofen 400")).toBe("simple_analgesic");
    expect(classifyMed("Paracetamol")).toBe("simple_analgesic");
    expect(classifyMed("aspirin")).toBe("simple_analgesic");
  });

  it("attributes a combination to the stricter triptan threshold", () => {
    expect(classifyMed("sumatriptan + ibuprofen")).toBe("triptan");
  });

  it("treats explicit negations as no medication", () => {
    for (const s of ["None", "none", "no meds", "nothing", "-", ""]) {
      expect(classifyMed(s)).toBe("none");
    }
    expect(classifyMed(null)).toBe("none");
  });

  it("keeps unrecognised text as a medication day rather than dropping it", () => {
    // Silently dropping it would undercount the thing a neurologist cares about.
    expect(classifyMed("some pill a friend gave me")).toBe("other");
  });
});

describe("medicationDays", () => {
  it("counts a day once per class no matter how many entries it has", () => {
    const out = medicationDays([
      { local_date: "2026-03-01", meds: "sumatriptan" },
      { local_date: "2026-03-01", meds: "sumatriptan" }, // same day
      { local_date: "2026-03-02", meds: "ibuprofen" },
      { local_date: "2026-03-03", meds: "None" },
      { local_date: "2026-03-04", meds: "mystery pill" },
    ]);
    expect(out).toEqual([
      {
        month: "2026-03",
        medication_days: 3,
        triptan_days: 1,
        simple_analgesic_days: 1,
        unclassified_days: 1,
        triptan_threshold_reached: false,
        analgesic_threshold_reached: false,
      },
    ]);
  });

  it("flags the ICHD-3 day counts per class", () => {
    const triptan = Array.from({ length: 10 }, (_, i) => ({
      local_date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      meds: "sumatriptan",
    }));
    const [m] = medicationDays(triptan);
    expect(m.triptan_days).toBe(10);
    expect(m.triptan_threshold_reached).toBe(true);
    expect(m.analgesic_threshold_reached).toBe(false);

    const analgesic = Array.from({ length: 14 }, (_, i) => ({
      local_date: `2026-04-${String(i + 1).padStart(2, "0")}`,
      meds: "ibuprofen",
    }));
    expect(medicationDays(analgesic)[0].analgesic_threshold_reached).toBe(false); // 14 < 15
  });
});

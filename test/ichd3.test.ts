import { describe, it, expect } from "vitest";
import { classifyAttack, isMigraine, type AttackAttributes } from "../src/shared/ichd3";

// A fully-recorded classic migraine without aura, as a base to vary from.
const base: AttackAttributes = {
  side: "one",
  quality: "throbbing",
  aggravated_by_activity: true,
  nausea: true,
  photophobia: true,
  phonophobia: true,
  aura: false,
  severity: 8,
  duration_hours: 12,
};

describe("classifyAttack", () => {
  it("meets criteria for migraine without aura when C>=2 and D are met", () => {
    const r = classifyAttack(base);
    expect(r.verdict).toBe("migraine_without_aura");
    expect(r.c_met_count).toBe(4);
    expect(r.associated_symptom).toBe(true);
    expect(r.met).toContain("one-sided");
    expect(isMigraine(r.verdict)).toBe(true);
  });

  it("promotes to migraine with aura when aura is present", () => {
    const r = classifyAttack({ ...base, aura: true });
    expect(r.verdict).toBe("migraine_with_aura");
    expect(isMigraine(r.verdict)).toBe(true);
  });

  it("needs only two of the four pain features", () => {
    // Unilateral + throbbing, mild and not aggravated, but nausea present.
    const r = classifyAttack({
      ...base,
      severity: 3, // drives moderate_or_severe -> false
      aggravated_by_activity: false,
    });
    expect(r.criteria.moderate_or_severe).toBe(false);
    expect(r.criteria.aggravated_by_activity).toBe(false);
    expect(r.c_met_count).toBe(2); // unilateral + pulsating
    expect(r.verdict).toBe("migraine_without_aura");
  });

  it("counts nausea alone as the associated-symptom criterion", () => {
    const r = classifyAttack({ ...base, photophobia: false, phonophobia: false });
    expect(r.associated_symptom).toBe(true); // nausea is enough
    expect(r.verdict).toBe("migraine_without_aura");
  });

  it("requires BOTH photophobia and phonophobia when nausea is absent", () => {
    const r = classifyAttack({
      ...base,
      nausea: false,
      photophobia: true,
      phonophobia: false,
    });
    expect(r.associated_symptom).toBe(false);
    // C is still met (4 features), but D fails, so it is not migraine.
    expect(r.verdict).not.toBe("migraine_without_aura");
  });

  it("does not classify a migraine when duration is known to be out of range", () => {
    const r = classifyAttack({ ...base, duration_hours: 200 });
    expect(r.duration_ok).toBe(false);
    expect(r.verdict).toBe("unclassified");
    expect(r.missing).toContain("duration outside 4-72h");
  });

  it("still classifies when duration is unknown (imported rows)", () => {
    const r = classifyAttack({ ...base, duration_hours: null });
    expect(r.duration_ok).toBeNull();
    expect(r.verdict).toBe("migraine_without_aura");
  });

  it("returns unclassified, not tension-type, when nothing is recorded", () => {
    const r = classifyAttack({
      side: null,
      quality: null,
      aggravated_by_activity: null,
      nausea: null,
      photophobia: null,
      phonophobia: null,
      aura: null,
      severity: null,
      duration_hours: null,
    });
    expect(r.verdict).toBe("unclassified");
    expect(r.missing).toContain("no attributes recorded");
    expect(isMigraine(r.verdict)).toBe(false);
  });

  it("calls a bilateral, pressing, calm, symptom-free attack tension-type", () => {
    const r = classifyAttack({
      side: "both",
      quality: "pressing",
      aggravated_by_activity: false,
      nausea: false,
      photophobia: false,
      phonophobia: false,
      aura: false,
      severity: 4,
      duration_hours: 5,
    });
    expect(r.verdict).toBe("tension_type_consistent");
    expect(isMigraine(r.verdict)).toBe(false);
  });

  it("never treats missing symptom data as a tension-type match", () => {
    // Bilateral and pressing, but nausea/light/sound were not recorded. Tension-type
    // requires the symptoms to be positively absent, so this stays undecided.
    const r = classifyAttack({
      side: "both",
      quality: "pressing",
      aggravated_by_activity: false,
      nausea: null,
      photophobia: null,
      phonophobia: null,
      aura: null,
      severity: 4,
      duration_hours: 5,
    });
    expect(r.verdict).not.toBe("tension_type_consistent");
  });

  it("marks a near-miss as probable migraine when the shortfall is missing data", () => {
    // Two strong pain features, but the associated symptoms were never recorded.
    const r = classifyAttack({
      side: "one",
      quality: "throbbing",
      aggravated_by_activity: null,
      nausea: null,
      photophobia: null,
      phonophobia: null,
      aura: false,
      severity: 8,
      duration_hours: 10,
    });
    expect(r.verdict).toBe("probable_migraine");
    expect(isMigraine(r.verdict)).toBe(false); // probable does NOT count toward MMD
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, TestD1 } from "./d1-adapter";
import { buildSummary } from "../src/worker/insights";
import { medicationDays } from "../src/shared/meds";

// Acute-medication days are the number a neurologist reads for overuse. When the
// structured dose became the way to record medication, this counter still only read
// the legacy free-text field, so a day recorded with the dose button would silently
// not count. These lock both sources in, and lock out double counting.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("medicationDays across both sources", () => {
  it("counts a logged dose even when the drug was never named", () => {
    // The taking is the fact; the name is the detail. Dropping it undercounts.
    const out = medicationDays([
      { local_date: "2026-03-02", meds: null, is_dose: true },
    ]);
    expect(out[0].medication_days).toBe(1);
    expect(out[0].unclassified_days).toBe(1);
    expect(out[0].triptan_days).toBe(0);
  });

  it("still ignores a free-text 'none' that is not a dose", () => {
    expect(medicationDays([{ local_date: "2026-03-02", meds: "none" }])).toEqual([]);
    expect(medicationDays([{ local_date: "2026-03-02", meds: null }])).toEqual([]);
  });

  it("classifies a named dose into its ICHD-3 class", () => {
    const out = medicationDays([
      { local_date: "2026-03-02", meds: "Sumatriptan", is_dose: true },
    ]);
    expect(out[0].triptan_days).toBe(1);
  });

  it("counts a day once when it is recorded BOTH ways", () => {
    const out = medicationDays([
      { local_date: "2026-03-02", meds: "sumatriptan 50mg" },
      { local_date: "2026-03-02", meds: "Sumatriptan", is_dose: true },
    ]);
    expect(out[0].medication_days).toBe(1);
    expect(out[0].triptan_days).toBe(1);
  });
});

describe("buildSummary medication days read doses and legacy text", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  const addEpisode = async (localDate: string, meds: string | null, tz = "UTC") => {
    const r = await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, meds, tz)
         VALUES (?, ?, 1, 'app', ?, ?) RETURNING id`
      )
      .bind(`${localDate}T09:00:00.000Z`, localDate, meds, tz)
      .first<{ id: number }>();
    return r!.id;
  };

  const addDose = (episodeId: number, name: string | null, takenAt: string) =>
    d1
      .prepare(`INSERT INTO med_doses (episode_id, name, taken_at) VALUES (?,?,?)`)
      .bind(episodeId, name, takenAt)
      .run();

  it("counts a day whose medication exists only as a structured dose", async () => {
    const id = await addEpisode("2026-03-02", null);
    await addDose(id, "Sumatriptan", "2026-03-02T10:00:00.000Z");
    const s = await buildSummary(d1);
    expect(s.medication_days).toHaveLength(1);
    expect(s.medication_days[0].medication_days).toBe(1);
    expect(s.medication_days[0].triptan_days).toBe(1);
  });

  it("keeps counting the legacy free-text history", async () => {
    await addEpisode("2026-03-05", "ibuprofen 400mg");
    const s = await buildSummary(d1);
    expect(s.medication_days[0].simple_analgesic_days).toBe(1);
  });

  it("does not double count an episode recorded both ways on one day", async () => {
    const id = await addEpisode("2026-03-02", "sumatriptan 50mg");
    await addDose(id, "Sumatriptan", "2026-03-02T10:00:00.000Z");
    const s = await buildSummary(d1);
    expect(s.medication_days[0].medication_days).toBe(1);
    expect(s.medication_days[0].triptan_days).toBe(1);
  });

  it("counts an overnight dose on the day it was taken, not the day the attack began", async () => {
    // Attack starts 22:00 on the 2nd; the dose is swallowed at 01:00 on the 3rd.
    const id = await addEpisode("2026-03-02", null);
    await addDose(id, "Sumatriptan", "2026-03-03T01:00:00.000Z");
    const s = await buildSummary(d1);
    expect(s.medication_days[0].triptan_days).toBe(1);
    // Two distinct days would mean it was attributed to the attack's day as well.
    expect(s.medication_days[0].medication_days).toBe(1);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";
import { medicationResponse } from "../src/worker/meds";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const PIN = "test-pin";
const authed = { Authorization: `Bearer ${PIN}`, "Content-Type": "application/json" };
const env = (d1: TestD1) =>
  ({ DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } }) as never;

async function openEpisode(d1: TestD1): Promise<number> {
  const r = await app.request(
    "/api/episodes/start",
    { method: "POST", headers: authed, body: JSON.stringify({ client_started_at: "2026-07-07T10:00:00.000Z" }) },
    env(d1)
  );
  return ((await r.json()) as { id: number }).id;
}

describe("medication dose endpoints", () => {
  let d1: TestD1;
  beforeEach(() => {
    const fresh = freshDb(migrationsDir);
    // D1 enforces foreign keys in production; node:sqlite defaults them off, so
    // turn them on to exercise the ON DELETE CASCADE the schema relies on.
    fresh.raw.exec("PRAGMA foreign_keys = ON");
    d1 = fresh.d1;
  });

  it("logs a dose against an episode with a client time and name", async () => {
    const id = await openEpisode(d1);
    const res = await app.request(
      `/api/episodes/${id}/meds`,
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ name: "Sumatriptan", client_taken_at: "2026-07-07T10:30:00.000Z" }),
      },
      env(d1)
    );
    expect(res.status).toBe(201);
    const dose = (await res.json()) as { id: number; episode_id: number; name: string; taken_at: string; relief_at: null };
    expect(dose.episode_id).toBe(id);
    expect(dose.name).toBe("Sumatriptan");
    expect(dose.taken_at).toBe("2026-07-07T10:30:00.000Z");
    expect(dose.relief_at).toBeNull();
  });

  it("refuses a dose against a missing episode", async () => {
    const res = await app.request(
      `/api/episodes/9999/meds`,
      { method: "POST", headers: authed, body: JSON.stringify({}) },
      env(d1)
    );
    expect(res.status).toBe(404);
  });

  it("records relief with a residual level and lists it back", async () => {
    const id = await openEpisode(d1);
    const doseRes = await app.request(
      `/api/episodes/${id}/meds`,
      { method: "POST", headers: authed, body: JSON.stringify({ name: "Ibuprofen", client_taken_at: "2026-07-07T10:30:00.000Z" }) },
      env(d1)
    );
    const doseId = ((await doseRes.json()) as { id: number }).id;

    const relRes = await app.request(
      `/api/meds/${doseId}/relief`,
      { method: "POST", headers: authed, body: JSON.stringify({ relief_severity: 2, client_relief_at: "2026-07-07T11:15:00.000Z" }) },
      env(d1)
    );
    expect(relRes.status).toBe(200);
    const relieved = (await relRes.json()) as { relief_at: string; relief_severity: number };
    expect(relieved.relief_at).toBe("2026-07-07T11:15:00.000Z");
    expect(relieved.relief_severity).toBe(2);

    const listRes = await app.request(`/api/episodes/${id}/meds`, { headers: authed }, env(d1));
    const list = (await listRes.json()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it("rejects an out-of-range residual severity", async () => {
    const id = await openEpisode(d1);
    const doseRes = await app.request(
      `/api/episodes/${id}/meds`,
      { method: "POST", headers: authed, body: JSON.stringify({}) },
      env(d1)
    );
    const doseId = ((await doseRes.json()) as { id: number }).id;
    const relRes = await app.request(
      `/api/meds/${doseId}/relief`,
      { method: "POST", headers: authed, body: JSON.stringify({ relief_severity: 42 }) },
      env(d1)
    );
    expect(relRes.status).toBe(400);
  });

  it("cascade-deletes doses when the episode is deleted", async () => {
    const id = await openEpisode(d1);
    await app.request(
      `/api/episodes/${id}/meds`,
      { method: "POST", headers: authed, body: JSON.stringify({ name: "Sumatriptan" }) },
      env(d1)
    );
    await app.request(`/api/episodes/${id}`, { method: "DELETE", headers: authed }, env(d1));
    const rows = await d1.prepare(`SELECT COUNT(*) AS n FROM med_doses`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("medicationResponse analysis", () => {
  let d1: TestD1;
  beforeEach(() => {
    const fresh = freshDb(migrationsDir);
    // D1 enforces foreign keys in production; node:sqlite defaults them off, so
    // turn them on to exercise the ON DELETE CASCADE the schema relies on.
    fresh.raw.exec("PRAGMA foreign_keys = ON");
    d1 = fresh.d1;
  });

  const seedEpisode = async () => {
    const r = await d1
      .prepare(`INSERT INTO episodes (started_at, local_date, source) VALUES ('2026-07-07T10:00:00Z','2026-07-07','app') RETURNING id`)
      .first<{ id: number }>();
    return r!.id;
  };

  const seedDose = async (
    episodeId: number,
    name: string | null,
    takenAt: string,
    reliefAt: string | null,
    residual: number | null
  ) =>
    d1
      .prepare(
        `INSERT INTO med_doses (episode_id, name, taken_at, relief_at, relief_severity)
         VALUES (?,?,?,?,?)`
      )
      .bind(episodeId, name, takenAt, reliefAt, residual)
      .run();

  it("reports insufficient data below the dose floor", async () => {
    const ep = await seedEpisode();
    await seedDose(ep, "Sumatriptan", "2026-07-07T10:00:00Z", null, null);
    const r = await medicationResponse(d1);
    expect(r.verdict).toBe("insufficient data");
    expect(r.overall.doses).toBe(1);
  });

  it("computes relief rate, median time-to-relief and median residual", async () => {
    const ep = await seedEpisode();
    // Three relieved doses at 30/60/90 min, residuals 0/2/4; one dose with no relief.
    await seedDose(ep, "Sumatriptan", "2026-07-07T10:00:00Z", "2026-07-07T10:30:00Z", 0);
    await seedDose(ep, "Sumatriptan", "2026-07-07T11:00:00Z", "2026-07-07T12:00:00Z", 2);
    await seedDose(ep, "Sumatriptan", "2026-07-07T13:00:00Z", "2026-07-07T14:30:00Z", 4);
    await seedDose(ep, "Sumatriptan", "2026-07-07T15:00:00Z", null, null);
    const r = await medicationResponse(d1);
    expect(r.verdict).toBe("summary");
    expect(r.overall.doses).toBe(4);
    expect(r.overall.doses_with_relief).toBe(3);
    expect(r.overall.relief_rate).toBeCloseTo(0.75, 5);
    // times: 30, 60, 90 -> median 60
    expect(r.overall.median_minutes_to_relief).toBe(60);
    // residuals: 0, 2, 4 -> median 2
    expect(r.overall.median_residual).toBe(2);
  });

  it("never zero-fills the time of a dose that never brought relief", async () => {
    const ep = await seedEpisode();
    await seedDose(ep, "A", "2026-07-07T10:00:00Z", "2026-07-07T10:20:00Z", 1);
    await seedDose(ep, "A", "2026-07-07T11:00:00Z", null, null);
    await seedDose(ep, "A", "2026-07-07T12:00:00Z", null, null);
    const r = await medicationResponse(d1);
    // Only the single relieved dose informs the time; the two blanks are not 0 min.
    expect(r.overall.median_minutes_to_relief).toBe(20);
    expect(r.overall.relief_rate).toBeCloseTo(1 / 3, 5);
  });

  it("breaks down by named medication above the floor", async () => {
    const ep = await seedEpisode();
    for (let i = 0; i < 3; i++)
      await seedDose(ep, "Sumatriptan", `2026-07-0${i + 1}T10:00:00Z`, `2026-07-0${i + 1}T10:30:00Z`, 1);
    for (let i = 0; i < 3; i++)
      await seedDose(ep, "Ibuprofen", `2026-07-0${i + 1}T14:00:00Z`, null, null);
    const r = await medicationResponse(d1);
    const byName = Object.fromEntries(r.by_medication.map((g) => [g.medication, g]));
    expect(byName["Sumatriptan"].relief_rate).toBe(1);
    expect(byName["Ibuprofen"].relief_rate).toBe(0);
  });
});

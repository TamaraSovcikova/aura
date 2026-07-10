import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);

const PIN = "test-pin";
const authed = {
  Authorization: `Bearer ${PIN}`,
  "Content-Type": "application/json",
};

function env(d1: TestD1) {
  return {
    DB: d1,
    ACCESS_PIN: PIN,
    ASSETS: { fetch: async () => new Response("") },
  } as never;
}

describe("episodes API", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("start -> current -> end round-trip with correct fields", async () => {
    const startRes = await app.request(
      "/api/episodes/start",
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          client_started_at: "2026-07-07T10:00:00.000Z",
          tz: "Europe/London",
        }),
      },
      env(d1)
    );
    expect(startRes.status).toBe(201);
    const started = (await startRes.json()) as { id: number; ended_at: null };
    expect(started.id).toBeGreaterThan(0);
    expect(started.ended_at).toBeNull();

    const curRes = await app.request(
      "/api/episodes/current",
      { headers: authed },
      env(d1)
    );
    const cur = (await curRes.json()) as { id: number };
    expect(cur.id).toBe(started.id);

    const endRes = await app.request(
      `/api/episodes/${started.id}/end`,
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          client_ended_at: "2026-07-07T11:00:00.000Z",
          severity: 2,
        }),
      },
      env(d1)
    );
    expect(endRes.status).toBe(200);
    const ended = (await endRes.json()) as {
      ended_at: string;
      severity: number;
    };
    expect(ended.ended_at).toBe("2026-07-07T11:00:00.000Z");
    expect(ended.severity).toBe(2);

    const cur2 = await app.request(
      "/api/episodes/current",
      { headers: authed },
      env(d1)
    );
    expect(await cur2.json()).toBeNull();
  });

  it("still saves (201) with null enrichment when Open-Meteo fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no network");
      })
    );
    const res = await app.request(
      "/api/episodes/start",
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ lat: 51.5, lon: -0.12, tz: "Europe/London" }),
      },
      env(d1)
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { pressure_hpa: null; lat: number };
    expect(row.pressure_hpa).toBeNull();
    expect(row.lat).toBe(51.5);
  });

  it("enriches pressure and weather when Open-Meteo is reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              current: {
                temperature_2m: 12,
                surface_pressure: 1007.5,
                weather_code: 61,
              },
            }),
            { status: 200 }
          )
      )
    );
    const res = await app.request(
      "/api/episodes/start",
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ lat: 51.5, lon: -0.12 }),
      },
      env(d1)
    );
    const row = (await res.json()) as {
      pressure_hpa: number;
      weather_code: number;
    };
    expect(row.pressure_hpa).toBe(1007.5);
    expect(row.weather_code).toBe(61);
  });

  it("patches editable fields, then deletes the episode", async () => {
    const s = await app.request(
      "/api/episodes/start",
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ client_started_at: "2026-07-07T10:00:00.000Z" }),
      },
      env(d1)
    );
    const { id } = (await s.json()) as { id: number };

    const p = await app.request(
      `/api/episodes/${id}`,
      {
        method: "PATCH",
        headers: authed,
        body: JSON.stringify({ severity: 3, note: "worse" }),
      },
      env(d1)
    );
    expect(p.status).toBe(200);
    const patched = (await p.json()) as { severity: number; note: string };
    expect(patched.severity).toBe(3);
    expect(patched.note).toBe("worse");

    const del = await app.request(
      `/api/episodes/${id}`,
      { method: "DELETE", headers: authed },
      env(d1)
    );
    expect(del.status).toBe(200);

    const list = (await (
      await app.request("/api/episodes?limit=5", { headers: authed }, env(d1))
    ).json()) as unknown[];
    expect(list).toHaveLength(0);

    const del2 = await app.request(
      `/api/episodes/${id}`,
      { method: "DELETE", headers: authed },
      env(d1)
    );
    expect(del2.status).toBe(404);
  });

  it("stores severity on the 0-10 scale and records a peak sample", async () => {
    const s = await app.request(
      "/api/episodes/start",
      { method: "POST", headers: authed, body: JSON.stringify({ tz: "Europe/London" }) },
      env(d1)
    );
    const { id } = (await s.json()) as { id: number };

    const e = await app.request(
      `/api/episodes/${id}/end`,
      { method: "POST", headers: authed, body: JSON.stringify({ severity: 7 }) },
      env(d1)
    );
    expect(e.status).toBe(200);
    expect(((await e.json()) as { severity: number }).severity).toBe(7);

    const samples = await d1
      .prepare(`SELECT level, kind FROM severity_samples WHERE episode_id = ?`)
      .bind(id)
      .all<{ level: number; kind: string }>();
    expect(samples.results).toEqual([{ level: 7, kind: "peak" }]);
  });

  it("rejects an off-scale severity rather than corrupting the scale", async () => {
    const s = await app.request(
      "/api/episodes/start",
      { method: "POST", headers: authed, body: JSON.stringify({}) },
      env(d1)
    );
    const { id } = (await s.json()) as { id: number };

    for (const bad of [11, -1, 2.5]) {
      const r = await app.request(
        `/api/episodes/${id}/end`,
        { method: "POST", headers: authed, body: JSON.stringify({ severity: bad }) },
        env(d1)
      );
      expect(r.status).toBe(400);
    }
  });

  it("re-editing severity replaces the peak sample instead of stacking", async () => {
    const s = await app.request(
      "/api/episodes/start",
      { method: "POST", headers: authed, body: JSON.stringify({}) },
      env(d1)
    );
    const { id } = (await s.json()) as { id: number };

    await app.request(
      `/api/episodes/${id}/end`,
      { method: "POST", headers: authed, body: JSON.stringify({ severity: 6 }) },
      env(d1)
    );
    await app.request(
      `/api/episodes/${id}`,
      { method: "PATCH", headers: authed, body: JSON.stringify({ severity: 9 }) },
      env(d1)
    );

    const samples = await d1
      .prepare(`SELECT level FROM severity_samples WHERE episode_id = ? AND kind = 'peak'`)
      .bind(id)
      .all<{ level: number }>();
    expect(samples.results).toEqual([{ level: 9 }]);
  });

  it("sets local_date from the timezone, not the UTC date", async () => {
    // 23:30 BST on 2025-06-15 is 22:30 UTC the same day; the local day must win.
    const s = await app.request(
      "/api/episodes/start",
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          client_started_at: "2025-06-15T23:30:00.000Z", // 00:30 on the 16th in London
          tz: "Europe/London",
        }),
      },
      env(d1)
    );
    const row = (await s.json()) as { local_date: string };
    expect(row.local_date).toBe("2025-06-16");
  });

  it("never treats an imported episode as the currently-open attack", async () => {
    // Imported history has no ended_at, but that means "duration unknown", not
    // "in progress". Without the source guard a 2024 migraine surfaces as open.
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, ended_at, source, source_file)
         VALUES ('2024-08-26T10:00:00.000Z', '2024-08-26', NULL, 'obsidian-import', '2024-08-26_Migraine.md')`
      )
      .run();

    const res = await app.request(
      "/api/episodes/current",
      { headers: authed },
      env(d1)
    );
    expect(await res.json()).toBeNull();

    // An app-captured unended episode still is open.
    await app.request(
      "/api/episodes/start",
      { method: "POST", headers: authed, body: JSON.stringify({}) },
      env(d1)
    );
    const res2 = await app.request(
      "/api/episodes/current",
      { headers: authed },
      env(d1)
    );
    const cur = (await res2.json()) as { source: string } | null;
    expect(cur?.source).toBe("app");
  });

  it("rejects an API call without a valid PIN", async () => {
    const res = await app.request(
      "/api/episodes/current",
      { headers: { "Content-Type": "application/json" } },
      env(d1)
    );
    expect(res.status).toBe(401);
  });

  it("allows /api/health without a PIN", async () => {
    const res = await app.request("/api/health", {}, env(d1));
    expect(res.status).toBe(200);
  });
});

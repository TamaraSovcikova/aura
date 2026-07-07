import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import app from "../src/worker/index";
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

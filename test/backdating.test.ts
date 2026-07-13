import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const PIN = "test-pin";
const authed = { Authorization: `Bearer ${PIN}`, "Content-Type": "application/json" };
function env(d1: TestD1) {
  return { DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } } as never;
}

async function start(d1: TestD1, body: Record<string, unknown>) {
  const res = await app.request(
    "/api/episodes/start",
    { method: "POST", headers: authed, body: JSON.stringify(body) },
    env(d1)
  );
  return res.json() as Promise<{
    id: number;
    started_at: string;
    local_date: string;
    started_at_time_known: number;
  }>;
}

async function patch(d1: TestD1, id: number, body: Record<string, unknown>) {
  const res = await app.request(
    `/api/episodes/${id}`,
    { method: "PATCH", headers: authed, body: JSON.stringify(body) },
    env(d1)
  );
  return {
    status: res.status,
    row: (await res.json()) as {
      started_at: string;
      ended_at: string | null;
      local_date: string;
      started_at_time_known: number;
    },
  };
}

describe("start-time precision", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  it("defaults a real-time tap to time-known", async () => {
    const row = await start(d1, { client_started_at: "2026-07-07T10:00:00.000Z", tz: "UTC" });
    expect(row.started_at_time_known).toBe(1);
  });

  it("records a backdated start as an estimate", async () => {
    // The client sends started_at_time_known:false for any adjusted onset.
    const row = await start(d1, {
      client_started_at: "2026-07-07T08:00:00.000Z",
      tz: "UTC",
      started_at_time_known: false,
    });
    expect(row.started_at_time_known).toBe(0);
  });

  it("keeps an estimated onset out of the premonition lead-time stat", async () => {
    // A premonition, then a headache 3h later whose start was only estimated.
    await app.request(
      "/api/premonitions",
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ client_felt_at: "2026-07-07T05:00:00.000Z", tz: "UTC" }),
      },
      env(d1)
    );
    await start(d1, {
      client_started_at: "2026-07-07T08:00:00.000Z",
      tz: "UTC",
      started_at_time_known: false,
    });

    const res = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "premonition_stats", arguments: { window_hours: 24 } },
        }),
      },
      env(d1)
    );
    const out = (await res.json()) as { result: { content: Array<{ text: string }> } };
    const stats = JSON.parse(out.result.content[0].text);
    // The episode exists, but its fuzzy start cannot count as a warned attack: a
    // time-unknown onset would fabricate a lead time.
    expect(stats.followed_by_headache).toBe(0);
  });
});

describe("correcting a start time", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  it("recomputes the headache day when the start moves across midnight", async () => {
    const row = await start(d1, { client_started_at: "2026-07-07T10:00:00.000Z", tz: "UTC" });
    expect(row.local_date).toBe("2026-07-07");

    // She realises it actually began late the previous night.
    const { row: moved } = await patch(d1, row.id, {
      started_at: "2026-07-06T23:00:00.000Z",
      started_at_time_known: 0,
    });
    expect(moved.local_date).toBe("2026-07-06");
    expect(moved.started_at_time_known).toBe(0);
  });

  it("recomputes the day in the episode's own timezone, not UTC", async () => {
    // 22:00 UTC is already tomorrow in Berlin (UTC+2 in July).
    const row = await start(d1, { client_started_at: "2026-07-07T10:00:00.000Z", tz: "Europe/Berlin" });
    const { row: moved } = await patch(d1, row.id, {
      started_at: "2026-07-07T22:30:00.000Z",
    });
    expect(moved.local_date).toBe("2026-07-08");
  });

  it("can promote an estimate back to a known time", async () => {
    const row = await start(d1, {
      client_started_at: "2026-07-07T08:00:00.000Z",
      tz: "UTC",
      started_at_time_known: false,
    });
    const { row: fixed } = await patch(d1, row.id, {
      started_at: "2026-07-07T08:15:00.000Z",
      started_at_time_known: 1,
    });
    expect(fixed.started_at_time_known).toBe(1);
    expect(fixed.started_at).toBe("2026-07-07T08:15:00.000Z");
  });

  it("corrects an end time without reopening the attack", async () => {
    const row = await start(d1, { client_started_at: "2026-07-07T10:00:00.000Z", tz: "UTC" });
    await app.request(
      `/api/episodes/${row.id}/end`,
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ client_ended_at: "2026-07-07T18:00:00.000Z" }),
      },
      env(d1)
    );
    const { row: fixed } = await patch(d1, row.id, {
      ended_at: "2026-07-07T15:30:00.000Z",
    });
    expect(fixed.ended_at).toBe("2026-07-07T15:30:00.000Z");

    const cur = await app.request("/api/episodes/current", { headers: authed }, env(d1));
    expect(await cur.json()).toBeNull(); // still closed
  });

  it("404s a patch to an episode that does not exist", async () => {
    const { status } = await patch(d1, 9999, { started_at: "2026-07-07T10:00:00.000Z" });
    expect(status).toBe(404);
  });
});

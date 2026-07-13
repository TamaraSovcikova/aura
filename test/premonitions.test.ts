import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";
import {
  reconcilePremonitions,
  type LocalPremonition,
} from "../src/client/premonitions";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);
const PIN = "test-pin";
const authed = { Authorization: `Bearer ${PIN}`, "Content-Type": "application/json" };
function env(d1: TestD1) {
  return { DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } } as never;
}

function prem(over: Partial<LocalPremonition> = {}): LocalPremonition {
  return {
    localId: "p1",
    felt_at: "2026-07-10T08:00:00.000Z",
    lat: null,
    lon: null,
    tz: "Europe/Berlin",
    synced: false,
    ...over,
  };
}

describe("premonition outbox", () => {
  it("sends each premonition at most once, so a retry cannot inflate the hit rate", async () => {
    const send = vi.fn(async () => {});
    let list = await reconcilePremonitions([prem()], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(list).toEqual([]); // synced -> dropped

    list = await reconcilePremonitions(list, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("posts a queued premonition only once when two reconcile passes race", async () => {
    // The F15 race: a launch deep-link fires onPremonition() while the initial
    // flush effect is already running. Each pass calls loadPremOutbox() and gets
    // its OWN copy of the outbox, so the two records are distinct objects that
    // share a localId, and the per-record `synced` flag on one copy cannot guard
    // the other. Without a shared guard both passes POST the same tap, producing
    // two /api/premonitions rows with an identical felt_at.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn(async () => {
      await gate; // hold both passes in-flight at the same moment
    });

    const passes = Promise.all([
      reconcilePremonitions([prem()], send),
      reconcilePremonitions([prem()], send),
    ]);
    release();
    const [a, b] = await passes;

    expect(send).toHaveBeenCalledTimes(1); // exactly one POST, no duplicate row
    expect(a).toEqual([]); // both passes see it synced and drop it
    expect(b).toEqual([]);
  });

  it("keeps the tap when the network fails, because it can never be reconstructed", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    const list = await reconcilePremonitions([prem()], send);
    expect(list).toHaveLength(1);
    expect(list[0].synced).toBe(false);
  });

  it("rethrows auth errors so the UI can re-prompt", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("unauthorized"), { name: "UnauthorizedError" });
    });
    await expect(reconcilePremonitions([prem()], send)).rejects.toThrow("unauthorized");
  });
});

describe("premonition API", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
    // Offline test env: no weather. Enrichment must never block the tap.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
  });

  const post = (body: unknown) =>
    app.request(
      "/api/premonitions",
      { method: "POST", headers: authed, body: JSON.stringify(body) },
      env(d1)
    );

  it("records a tap even when enrichment fails", async () => {
    const r = await post({ client_felt_at: "2026-07-10T08:00:00.000Z", tz: "Europe/Berlin" });
    expect(r.status).toBe(201);
    const row = (await r.json()) as { felt_at: string; local_date: string; pressure_hpa: null };
    expect(row.felt_at).toBe("2026-07-10T08:00:00.000Z");
    expect(row.local_date).toBe("2026-07-10");
    expect(row.pressure_hpa).toBeNull();
  });

  it("requires the PIN", async () => {
    const r = await app.request(
      "/api/premonitions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env(d1)
    );
    expect(r.status).toBe(401);
  });

  describe("derived stats", () => {
    const startEpisode = (startedAt: string) =>
      d1
        .prepare(
          `INSERT INTO episodes (started_at, local_date, ended_at, source)
           VALUES (?, substr(?,1,10), NULL, 'app')`
        )
        .bind(startedAt, startedAt)
        .run();

    it("pairs a premonition with a headache inside the window and reports lead time", async () => {
      await post({ client_felt_at: "2026-07-10T08:00:00.000Z" });
      await startEpisode("2026-07-10T14:00:00.000Z"); // 6h later

      const r = await app.request(
        "/api/premonitions/stats?window_hours=24",
        { headers: authed },
        env(d1)
      );
      const s = (await r.json()) as Record<string, number>;
      expect(s.premonitions_eligible).toBe(1);
      expect(s.followed_by_headache).toBe(1);
      expect(s.hit_rate).toBe(1);
      expect(s.lead_hours_median).toBe(6);
    });

    it("counts a false alarm as a miss rather than discarding it", async () => {
      await post({ client_felt_at: "2026-07-10T08:00:00.000Z" }); // followed
      await startEpisode("2026-07-10T14:00:00.000Z");
      await post({ client_felt_at: "2026-07-20T08:00:00.000Z" }); // nothing follows

      const r = await app.request(
        "/api/premonitions/stats?window_hours=24",
        { headers: authed },
        env(d1)
      );
      const s = (await r.json()) as Record<string, number>;
      expect(s.premonitions_eligible).toBe(2);
      expect(s.followed_by_headache).toBe(1);
      expect(s.hit_rate).toBe(0.5);
    });

    it("does not pair a headache that falls outside the window", async () => {
      await post({ client_felt_at: "2026-07-10T08:00:00.000Z" });
      await startEpisode("2026-07-12T08:00:00.000Z"); // 48h later

      const r = await app.request(
        "/api/premonitions/stats?window_hours=24",
        { headers: authed },
        env(d1)
      );
      const s = (await r.json()) as Record<string, number>;
      expect(s.followed_by_headache).toBe(0);
      expect(s.hit_rate).toBe(0);
    });

    it("excludes a premonition felt while an attack was already underway", async () => {
      // Not premonitory: the headache had already started.
      await startEpisode("2026-07-10T06:00:00.000Z");
      await post({ client_felt_at: "2026-07-10T08:00:00.000Z" });

      const r = await app.request(
        "/api/premonitions/stats?window_hours=24",
        { headers: authed },
        env(d1)
      );
      const s = (await r.json()) as Record<string, number | null>;
      expect(s.premonitions_eligible).toBe(0);
      expect(s.hit_rate).toBeNull();
    });

    it("an episode she forgot to end does not swallow later premonitions", async () => {
      // ended_at IS NULL forever. Capped at the ICHD-3 maximum of 72h, so a
      // premonition ten days later is still premonitory.
      await startEpisode("2026-07-10T06:00:00.000Z");
      await post({ client_felt_at: "2026-07-20T08:00:00.000Z" });

      const r = await app.request(
        "/api/premonitions/stats?window_hours=24",
        { headers: authed },
        env(d1)
      );
      const s = (await r.json()) as Record<string, number>;
      expect(s.premonitions_eligible).toBe(1);
    });

    it("compares timestamps numerically, not as strings", async () => {
      // 'YYYY-MM-DDTHH:MM:SSZ' vs SQLite's 'YYYY-MM-DD HH:MM:SS': 'T' > ' ',
      // so a naive string compare drops a same-day episode inside the window.
      await post({ client_felt_at: "2026-07-10T08:00:00.000Z" });
      await startEpisode("2026-07-10T23:30:00.000Z"); // 15.5h later, same day

      const r = await app.request(
        "/api/premonitions/stats?window_hours=24",
        { headers: authed },
        env(d1)
      );
      const s = (await r.json()) as Record<string, number>;
      expect(s.followed_by_headache).toBe(1);
      expect(s.lead_hours_median).toBeCloseTo(15.5, 1);
    });

    it("refuses to claim significance on a handful of taps", async () => {
      await post({ client_felt_at: "2026-07-10T08:00:00.000Z" });
      const r = await app.request(
        "/api/premonitions/stats",
        { headers: authed },
        env(d1)
      );
      const s = (await r.json()) as Record<string, unknown>;
      expect(s.enough_data).toBe(false);
    });
  });
});

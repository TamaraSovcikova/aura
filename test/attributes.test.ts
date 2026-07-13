import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";
import { buildSummary } from "../src/worker/insights";
import { deriveSide, parseRegions } from "../src/shared/headmap";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const PIN = "test-pin";
const authed = { Authorization: `Bearer ${PIN}`, "Content-Type": "application/json" };
function env(d1: TestD1) {
  return { DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } } as never;
}

async function startEpisode(d1: TestD1, startedAt: string) {
  const res = await app.request(
    "/api/episodes/start",
    { method: "POST", headers: authed, body: JSON.stringify({ client_started_at: startedAt, tz: "UTC" }) },
    env(d1)
  );
  return (await res.json()) as { id: number };
}

describe("head-map side derivation", () => {
  it("reads laterality from painted regions", () => {
    expect(deriveSide(["l-temple", "l-eye"])).toBe("one");
    expect(deriveSide(["r-forehead"])).toBe("one");
    expect(deriveSide(["l-temple", "r-temple"])).toBe("both");
    expect(deriveSide(["crown"])).toBe("both"); // midline only
    expect(deriveSide([])).toBeNull();
    expect(deriveSide(["nonsense-id"])).toBeNull(); // unknown ids ignored
  });
});

describe("writing attributes through the end call", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  it("stores the head map and derives side from it", async () => {
    const ep = await startEpisode(d1, "2026-07-07T10:00:00.000Z");
    const res = await app.request(
      `/api/episodes/${ep.id}/end`,
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          client_ended_at: "2026-07-07T18:00:00.000Z",
          severity: 8,
          quality: "throbbing",
          nausea: true,
          photophobia: true,
          phonophobia: true,
          pain_regions: ["l-temple", "l-eye"],
        }),
      },
      env(d1)
    );
    const row = (await res.json()) as {
      side: string;
      quality: string;
      nausea: number;
      pain_regions: string;
    };
    expect(row.side).toBe("one"); // derived from the left-only regions
    expect(row.quality).toBe("throbbing");
    expect(row.nausea).toBe(1);
    expect(parseRegions(row.pain_regions)).toEqual(["l-temple", "l-eye"]);
  });

  it("lets an explicit side override the map", async () => {
    const ep = await startEpisode(d1, "2026-07-07T10:00:00.000Z");
    const res = await app.request(
      `/api/episodes/${ep.id}/end`,
      {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ side: "both", pain_regions: ["l-temple"] }),
      },
      env(d1)
    );
    const row = (await res.json()) as { side: string };
    expect(row.side).toBe("both");
  });

  it("does not touch attributes that were not sent", async () => {
    const ep = await startEpisode(d1, "2026-07-07T10:00:00.000Z");
    await app.request(
      `/api/episodes/${ep.id}/end`,
      { method: "POST", headers: authed, body: JSON.stringify({ nausea: true }) },
      env(d1)
    );
    // A later patch of only the note must leave nausea intact.
    await app.request(
      `/api/episodes/${ep.id}`,
      { method: "PATCH", headers: authed, body: JSON.stringify({ note: "bad one" }) },
      env(d1)
    );
    const list = (await (
      await app.request(`/api/episodes?limit=1`, { headers: authed }, env(d1))
    ).json()) as Array<{ nausea: number; note: string }>;
    expect(list[0].nausea).toBe(1);
    expect(list[0].note).toBe("bad one");
  });

  it("can edit attributes after the fact through patch", async () => {
    const ep = await startEpisode(d1, "2026-07-07T10:00:00.000Z");
    await app.request(
      `/api/episodes/${ep.id}/end`,
      { method: "POST", headers: authed, body: JSON.stringify({ client_ended_at: "2026-07-07T14:00:00.000Z" }) },
      env(d1)
    );
    const res = await app.request(
      `/api/episodes/${ep.id}`,
      {
        method: "PATCH",
        headers: authed,
        body: JSON.stringify({ aura: true, pain_regions: ["r-temple"] }),
      },
      env(d1)
    );
    const row = (await res.json()) as { aura: number; side: string };
    expect(row.aura).toBe(1);
    expect(row.side).toBe("one");
  });
});

describe("Monthly Migraine Days in the summary", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  const endWith = (d1: TestD1, id: number, endedAt: string, attrs: Record<string, unknown>) =>
    app.request(
      `/api/episodes/${id}/end`,
      { method: "POST", headers: authed, body: JSON.stringify({ client_ended_at: endedAt, ...attrs }) },
      env(d1)
    );

  it("counts a fully-described classic attack as a migraine day, and leaves a bare one out", async () => {
    // A: full migraine picture. B: no attributes at all.
    const a = await startEpisode(d1, "2026-07-02T09:00:00.000Z");
    await endWith(d1, a.id, "2026-07-02T17:00:00.000Z", {
      severity: 8,
      quality: "throbbing",
      aggravated_by_activity: true,
      nausea: true,
      pain_regions: ["l-temple"],
    });
    const b = await startEpisode(d1, "2026-07-05T09:00:00.000Z");
    await endWith(d1, b.id, "2026-07-05T12:00:00.000Z", {});

    const s = await buildSummary(d1);
    expect(s.headache_days).toBe(2); // both are headache days
    expect(s.migraine_days).toBe(1); // only A meets the criteria
    expect(s.classified.migraine).toBe(1);
    expect(s.classified.attacks_with_attributes).toBe(1); // B has none
  });

  it("never turns an imported diary row into a migraine day", async () => {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, severity, self_reported_type)
         VALUES ('2026-06-01T12:00:00.000Z','2026-06-01',0,'obsidian',9,'migraine')`
      )
      .run();
    const s = await buildSummary(d1);
    expect(s.headache_days).toBe(1);
    expect(s.migraine_days).toBe(0); // self_reported_type is never trusted
    expect(s.classified.attacks_with_attributes).toBe(0);
  });
});

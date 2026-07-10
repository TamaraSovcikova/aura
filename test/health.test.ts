import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";
import {
  aggregateSleepSessions,
  sleepDayFor,
  validateHealthDays,
} from "../src/shared/health";
import { triggerAnalysis } from "../src/worker/triggers";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const PIN = "test-pin";
const authed = { Authorization: `Bearer ${PIN}`, "Content-Type": "application/json" };
function env(d1: TestD1) {
  return { DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } } as never;
}

describe("sleep attribution", () => {
  it("belongs to the day she WOKE, not the day she fell asleep", () => {
    // Asleep 23:30 on the 9th, awake 07:30 on the 10th. The exposure for a
    // headache on the 10th is this night. Keying it to the 9th would put every
    // value one day out of phase with the outcome.
    const s = { start: "2026-07-09T21:30:00.000Z", end: "2026-07-10T05:30:00.000Z" };
    expect(sleepDayFor(s, "Europe/Berlin")).toBe("2026-07-10");
  });

  it("respects the timezone when choosing the wake day", () => {
    // 23:30 UTC is already the next day in Berlin (UTC+2 in July).
    const s = { start: "2026-07-09T20:00:00.000Z", end: "2026-07-09T23:30:00.000Z" };
    expect(sleepDayFor(s, "Europe/Berlin")).toBe("2026-07-10");
    expect(sleepDayFor(s, "Europe/London")).toBe("2026-07-10"); // 00:30 BST
    expect(sleepDayFor(s, "UTC")).toBe("2026-07-09");
  });

  it("sums a nap onto the same wake day", () => {
    const out = aggregateSleepSessions(
      [
        { start: "2026-07-09T22:00:00.000Z", end: "2026-07-10T05:00:00.000Z" }, // 7h
        { start: "2026-07-10T12:00:00.000Z", end: "2026-07-10T13:00:00.000Z" }, // 1h nap
      ],
      "UTC"
    );
    expect(out).toEqual([{ local_date: "2026-07-10", sleep_minutes: 480 }]);
  });

  it("drops a broken session rather than clamping it", () => {
    const out = aggregateSleepSessions(
      [
        { start: "2026-07-10T05:00:00.000Z", end: "2026-07-10T04:00:00.000Z" }, // negative
        { start: "2026-07-01T00:00:00.000Z", end: "2026-07-05T00:00:00.000Z" }, // 4 days
        { start: "not-a-date", end: "2026-07-10T05:00:00.000Z" },
        { start: "2026-07-09T22:00:00.000Z", end: "2026-07-10T05:00:00.000Z" }, // good
      ],
      "UTC"
    );
    expect(out).toEqual([{ local_date: "2026-07-10", sleep_minutes: 420 }]);
  });
});

describe("validateHealthDays", () => {
  it("rejects physiologically impossible readings instead of storing them", () => {
    const { valid, rejected } = validateHealthDays([
      { local_date: "2026-07-10", sleep_minutes: 420 },
      { local_date: "2026-07-11", sleep_minutes: 1800 }, // 30 hours
      { local_date: "2026-07-12", resting_hr: 0 },
      { local_date: "2026-07-13", sleep_efficiency: 1.4 },
      { local_date: "nonsense", steps: 100 },
      { local_date: "2026-07-14" }, // nothing supplied
    ]);
    expect(valid).toEqual([{ local_date: "2026-07-10", sleep_minutes: 420 }]);
    expect(rejected).toHaveLength(5);
    expect(rejected[0].reason).toContain("sleep_minutes out of range");
  });

  it("accepts a partial push", () => {
    const { valid } = validateHealthDays([{ local_date: "2026-07-10", steps: 8000 }]);
    expect(valid[0]).toEqual({ local_date: "2026-07-10", steps: 8000 });
  });
});

describe("POST /api/days/health", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  const post = (body: unknown) =>
    app.request(
      "/api/days/health",
      { method: "POST", headers: authed, body: JSON.stringify(body) },
      env(d1)
    );

  const row = (date: string) =>
    d1.prepare(`SELECT * FROM days WHERE local_date = ?`).bind(date).first<Record<string, unknown>>();

  it("requires the PIN", async () => {
    const r = await app.request(
      "/api/days/health",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      env(d1)
    );
    expect(r.status).toBe(401);
  });

  it("creates a day that the weather backfill has not reached", async () => {
    const r = await post({ source: "health-connect", days: [{ local_date: "2026-07-10", sleep_minutes: 400 }] });
    expect(r.status).toBe(200);
    const d = await row("2026-07-10");
    expect(d!.sleep_minutes).toBe(400);
    expect(d!.health_source).toBe("health-connect");
    expect(d!.pressure_mean_hpa).toBeNull(); // weather untouched
  });

  it("NEVER clobbers the weather columns", async () => {
    await d1
      .prepare(
        `INSERT INTO days (local_date, place, tz, pressure_mean_hpa, pressure_delta_24h, dow, fetched_at)
         VALUES ('2026-07-10','Berlin, DE','Europe/Berlin', 1014.2, -3.5, 5, '2026-07-10T03:00:00Z')`
      )
      .run();

    await post({ source: "health-connect", days: [{ local_date: "2026-07-10", sleep_minutes: 400 }] });

    const d = await row("2026-07-10");
    expect(d!.pressure_mean_hpa).toBe(1014.2);
    expect(d!.pressure_delta_24h).toBe(-3.5);
    expect(d!.place).toBe("Berlin, DE");
    expect(d!.sleep_minutes).toBe(400);
  });

  it("merges a partial push instead of wiping the other fields", async () => {
    await post({ days: [{ local_date: "2026-07-10", sleep_minutes: 400, steps: 9000 }] });
    await post({ days: [{ local_date: "2026-07-10", resting_hr: 58 }] }); // only HR

    const d = await row("2026-07-10");
    expect(d!.sleep_minutes).toBe(400); // survived
    expect(d!.steps).toBe(9000); // survived
    expect(d!.resting_hr).toBe(58);
  });

  it("is idempotent", async () => {
    const body = { days: [{ local_date: "2026-07-10", sleep_minutes: 400 }] };
    await post(body);
    await post(body);
    const n = await d1.prepare(`SELECT count(*) AS n FROM days`).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("aggregates sleep_sessions onto the wake day, and demands a timezone", async () => {
    const noTz = await post({
      sleep_sessions: [{ start: "2026-07-09T22:00:00.000Z", end: "2026-07-10T05:00:00.000Z" }],
    });
    expect(noTz.status).toBe(400);

    const ok = await post({
      source: "health-connect",
      tz: "UTC",
      sleep_sessions: [{ start: "2026-07-09T22:00:00.000Z", end: "2026-07-10T05:00:00.000Z" }],
    });
    expect(ok.status).toBe(200);
    const d = await row("2026-07-10");
    expect(d!.sleep_minutes).toBe(420);
  });

  it("reports what it rejected rather than silently dropping it", async () => {
    const r = await post({ days: [{ local_date: "2026-07-10", sleep_minutes: 5000 }] });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { rejected: Array<{ reason: string }> };
    expect(body.rejected[0].reason).toContain("out of range");
  });
});

describe("health factors in the trigger engine", () => {
  let d1: TestD1;
  beforeEach(() => {
    d1 = freshDb(migrationsDir).d1;
  });

  it("an empty health column cannot dilute the weather results", async () => {
    // Sleep has no data. It must report 'insufficient data' AND be excluded from
    // the multiple-comparison correction, so it cannot raise the weather q-values
    // simply by existing as a column.
    for (let m = 0; m < 12; m++) {
      const month = String(m + 1).padStart(2, "0");
      for (let i = 1; i <= 28; i++) {
        const date = `2025-${month}-${String(i).padStart(2, "0")}`;
        await d1
          .prepare(
            `INSERT INTO days (local_date, place, tz, pressure_delta_24h, dow, fetched_at)
             VALUES (?, 'London, UK', 'Europe/London', ?, 1, '2026-01-01T00:00:00Z')`
          )
          .bind(date, (i % 5) - 2)
          .run();
        if (i % 3 === 0) {
          await d1
            .prepare(
              `INSERT INTO episodes (started_at, local_date, started_at_time_known, source)
               VALUES (?, ?, 1, 'app')`
            )
            .bind(`${date}T12:00:00.000Z`, date)
            .run();
        }
      }
    }

    const r = await triggerAnalysis(d1 as unknown as D1Database);
    const sleep = r.factors.find((f) => f.factor === "sleep_minutes")!;
    expect(sleep.verdict).toBe("insufficient data");
    expect(sleep.q).toBeNull(); // excluded from the FDR correction

    const pressure = r.factors.find((f) => f.factor === "pressure_delta_24h")!;
    expect(pressure.q).not.toBeNull();
    expect(pressure.verdict).not.toBe("insufficient data");
  });
});

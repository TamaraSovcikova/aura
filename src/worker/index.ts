import { Hono } from "hono";
import type { Bindings } from "./db";
import { attributeUpdates, checkPin, localDate, nowIso, upsertPeakSample, validSeverity } from "./db";
import { mcp } from "./mcp";
import { premonitionStats } from "./stats";
import { backfillDays, refreshRecentDays, upsertHealthDays } from "./days";
import { aggregateSleepSessions, validateHealthDays } from "../shared/health";
import { triggerAnalysis } from "./triggers";
import { dayOfWeekAnalysis, timeOfDayAnalysis } from "./patterns";
import { menstrualAnalysis } from "./cycle";
import { medicationResponse } from "./meds";
import { buildSummary } from "./insights";
import { doctorHtml, episodesCsv, obsidianMarkdown } from "./export";
import { fetchEnrichment, roundCoord } from "./enrich";
import type { Episode, StartBody, EndBody, MedDose, DoseBody, ReliefBody } from "../shared/types";

const app = new Hono<{ Bindings: Bindings }>();

// --- Access guard ----------------------------------------------------------
// Every /api route except /api/health requires the bearer PIN. Fail-closed: if the
// secret is missing the API refuses to serve rather than exposing health data.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const auth = checkPin(c.env.ACCESS_PIN, c.req.header("Authorization"));
  if (auth === "misconfigured") {
    console.error("ACCESS_PIN is not set, refusing all API requests. Set the secret and redeploy.");
    return c.json({ error: "server misconfigured" }, 503);
  }
  if (auth === "unauthorized") return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true, app: "aura" }));

// --- Episodes --------------------------------------------------------------

// Open a new episode. Enrichment is best-effort and never blocks the write.
app.post("/api/episodes/start", async (c) => {
  const body = await c.req.json<StartBody>().catch(() => ({}) as StartBody);
  const startedAt = body.client_started_at ?? nowIso();
  const tz = body.tz ?? null;
  const lat = typeof body.lat === "number" ? roundCoord(body.lat) : null;
  const lon = typeof body.lon === "number" ? roundCoord(body.lon) : null;
  const enr = await fetchEnrichment(body.lat, body.lon);

  // Default known. Only an estimate (backdated or woken-with) sets this false.
  const timeKnown = body.started_at_time_known === false ? 0 : 1;

  const row = await c.env.DB.prepare(
    `INSERT INTO episodes
       (started_at, local_date, started_at_time_known, tz, lat, lon,
        weather_code, pressure_hpa, temp_c, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'app')
     RETURNING *`
  )
    .bind(
      startedAt,
      localDate(startedAt, tz),
      timeKnown,
      tz,
      lat,
      lon,
      enr.weather_code,
      enr.pressure_hpa,
      enr.temp_c
    )
    .first<Episode>();

  return c.json(row, 201);
});

// Close an episode, with optional severity / meds / note.
app.post("/api/episodes/:id/end", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const body = await c.req.json<EndBody>().catch(() => ({}) as EndBody);
  const endedAt = body.client_ended_at ?? nowIso();

  // Severity is a 0-10 VAS. Reject anything else rather than storing a bad scale.
  if (body.severity !== undefined && body.severity !== null && validSeverity(body.severity) === null) {
    return c.json({ error: "severity must be an integer 0-10" }, 400);
  }
  const severity = validSeverity(body.severity);

  // The ICHD-3 attribute panel is optional and posts through the same call, so an
  // end that carries a head map and symptoms writes them in one round-trip.
  const attrs = attributeUpdates(body);
  const sets = [
    "ended_at = ?",
    "severity = COALESCE(?, severity)",
    "meds = COALESCE(?, meds)",
    "note = COALESCE(?, note)",
    ...attrs.sets,
    "updated_at = ?",
  ];
  const vals = [endedAt, severity, body.meds ?? null, body.note ?? null, ...attrs.vals, nowIso(), id];

  const row = await c.env.DB.prepare(
    `UPDATE episodes SET ${sets.join(", ")} WHERE id = ? RETURNING *`
  )
    .bind(...vals)
    .first<Episode>();

  if (!row) return c.json({ error: "not found" }, 404);
  if (severity !== null) await upsertPeakSample(c.env.DB, id, severity, endedAt);
  return c.json(row);
});

// The currently-open episode (if any), so the UI knows to show "end".
//
// Only app-captured episodes can be open. Imported history has no end time, but
// that means "duration unknown", not "still happening" -- without this guard a
// migraine from 2024 would surface as the attack currently in progress.
app.get("/api/episodes/current", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT * FROM episodes
      WHERE ended_at IS NULL AND source = 'app'
      ORDER BY started_at DESC LIMIT 1`
  ).first<Episode>();
  return c.json(row ?? null);
});

// Episodes, newest first.
//
// Each row carries a small medication summary so the log can show what was taken
// and whether it helped without a request per row. The counts are deliberately not
// the doses themselves: the list needs "was anything taken, did it work", and the
// detail sheet fetches the doses when it actually needs them.
app.get("/api/episodes", async (c) => {
  const raw = Number(c.req.query("limit") ?? 30);
  const limit = Math.min(Number.isFinite(raw) && raw > 0 ? raw : 30, 500);
  const res = await c.env.DB.prepare(
    `SELECT e.*,
            (SELECT COUNT(*) FROM med_doses d WHERE d.episode_id = e.id) AS dose_count,
            (SELECT COUNT(*) FROM med_doses d
              WHERE d.episode_id = e.id AND d.relief_at IS NOT NULL) AS dose_relief_count
       FROM episodes e
      ORDER BY e.started_at DESC
      LIMIT ?`
  )
    .bind(limit)
    .all<Episode>();
  return c.json(res.results);
});

// Fix a mistake: patch a subset of editable fields.
app.patch("/api/episodes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const body = await c.req
    .json<Partial<Episode>>()
    .catch(() => ({}) as Partial<Episode>);

  if (body.severity !== undefined && body.severity !== null && validSeverity(body.severity) === null) {
    return c.json({ error: "severity must be an integer 0-10" }, 400);
  }

  // The timezone is needed to recompute local_date when the start moves, so the
  // row must be read before it is written.
  const existing = await c.env.DB.prepare(`SELECT tz FROM episodes WHERE id = ?`)
    .bind(id)
    .first<{ tz: string | null }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const editable = [
    "started_at",
    "ended_at",
    "severity",
    "meds",
    "note",
  ] as const;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of editable) {
    if (f in body) {
      sets.push(`${f} = ?`);
      vals.push((body as Record<string, unknown>)[f] ?? null);
    }
  }

  // A corrected start time is often an estimate, and it can cross midnight into a
  // different headache day. Both must follow the timestamp, or a fixed onset would
  // still be counted on the wrong day and still trusted as precise.
  if ("started_at_time_known" in body) {
    sets.push("started_at_time_known = ?");
    vals.push(body.started_at_time_known ? 1 : 0);
  }
  if ("started_at" in body && typeof body.started_at === "string") {
    sets.push("local_date = ?");
    vals.push(localDate(body.started_at, existing.tz));
  }

  // ICHD-3 attributes and the head map, editable after the fact like everything else.
  const attrs = attributeUpdates(body as unknown as EndBody);
  sets.push(...attrs.sets);
  vals.push(...attrs.vals);

  if (sets.length === 0) return c.json({ error: "no editable fields" }, 400);
  sets.push("updated_at = ?");
  vals.push(nowIso());
  vals.push(id);

  const row = await c.env.DB.prepare(
    `UPDATE episodes SET ${sets.join(", ")} WHERE id = ? RETURNING *`
  )
    .bind(...vals)
    .first<Episode>();

  if (!row) return c.json({ error: "not found" }, 404);

  const severity = validSeverity(body.severity);
  if (severity !== null) {
    await upsertPeakSample(c.env.DB, id, severity, row.ended_at ?? nowIso());
  }
  return c.json(row);
});

// --- Medication doses ------------------------------------------------------
// A dose taken mid-attack: logged with one tap. The optional "I feel better"
// follow-up (relief endpoint) is what turns two timestamps into time-to-effect.

// Log a dose against an episode. `name` optional; `client_taken_at` lets an
// offline log carry the real moment rather than the sync time.
app.post("/api/episodes/:id/meds", async (c) => {
  const episodeId = Number(c.req.param("id"));
  if (!Number.isInteger(episodeId)) return c.json({ error: "bad id" }, 400);
  const body = await c.req.json<DoseBody>().catch(() => ({}) as DoseBody);
  const takenAt = body.client_taken_at ?? nowIso();

  // The episode must exist, or a dose would dangle against nothing.
  const ep = await c.env.DB.prepare(`SELECT id FROM episodes WHERE id = ?`)
    .bind(episodeId)
    .first<{ id: number }>();
  if (!ep) return c.json({ error: "episode not found" }, 404);

  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  const row = await c.env.DB.prepare(
    `INSERT INTO med_doses (episode_id, name, taken_at)
     VALUES (?, ?, ?) RETURNING *`
  )
    .bind(episodeId, name, takenAt)
    .first<MedDose>();
  return c.json(row, 201);
});

// Record that a logged dose brought relief: when, and to what residual level.
app.post("/api/meds/:doseId/relief", async (c) => {
  const doseId = Number(c.req.param("doseId"));
  if (!Number.isInteger(doseId)) return c.json({ error: "bad id" }, 400);
  const body = await c.req.json<ReliefBody>().catch(() => ({}) as ReliefBody);
  const reliefAt = body.client_relief_at ?? nowIso();

  if (
    body.relief_severity !== undefined &&
    body.relief_severity !== null &&
    validSeverity(body.relief_severity) === null
  ) {
    return c.json({ error: "relief_severity must be an integer 0-10" }, 400);
  }
  const residual = validSeverity(body.relief_severity);

  const row = await c.env.DB.prepare(
    `UPDATE med_doses SET relief_at = ?, relief_severity = ?
      WHERE id = ? RETURNING *`
  )
    .bind(reliefAt, residual, doseId)
    .first<MedDose>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

// Remove a dose logged by mistake. Doses are the source of truth for medication
// now, and they feed the ICHD-3 overuse day count, so a mis-tap has to be
// correctable rather than permanently inflating a clinical number.
app.delete("/api/meds/:doseId", async (c) => {
  const doseId = Number(c.req.param("doseId"));
  if (!Number.isInteger(doseId)) return c.json({ error: "bad id" }, 400);
  const row = await c.env.DB.prepare(`DELETE FROM med_doses WHERE id = ? RETURNING id`)
    .bind(doseId)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Doses for an episode, oldest first (the order they were taken).
app.get("/api/episodes/:id/meds", async (c) => {
  const episodeId = Number(c.req.param("id"));
  if (!Number.isInteger(episodeId)) return c.json({ error: "bad id" }, 400);
  const res = await c.env.DB.prepare(
    `SELECT * FROM med_doses WHERE episode_id = ? ORDER BY taken_at ASC`
  )
    .bind(episodeId)
    .all<MedDose>();
  return c.json(res.results);
});

// --- Premonitions ----------------------------------------------------------
// "I feel one coming." One tap, never linked to an episode by the user.

interface PremonitionBody {
  lat?: number;
  lon?: number;
  tz?: string;
  note?: string;
  client_felt_at?: string;
}

app.post("/api/premonitions", async (c) => {
  const body = await c.req
    .json<PremonitionBody>()
    .catch(() => ({}) as PremonitionBody);
  const feltAt = body.client_felt_at ?? nowIso();
  const tz = body.tz ?? null;
  const lat = typeof body.lat === "number" ? roundCoord(body.lat) : null;
  const lon = typeof body.lon === "number" ? roundCoord(body.lon) : null;
  const enr = await fetchEnrichment(body.lat, body.lon);

  const row = await c.env.DB.prepare(
    `INSERT INTO premonitions
       (felt_at, local_date, note, tz, lat, lon, weather_code, pressure_hpa, temp_c, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'app')
     RETURNING *`
  )
    .bind(
      feltAt,
      localDate(feltAt, tz),
      body.note ?? null,
      tz,
      lat,
      lon,
      enr.weather_code,
      enr.pressure_hpa,
      enr.temp_c
    )
    .first();

  return c.json(row, 201);
});

app.get("/api/premonitions", async (c) => {
  const raw = Number(c.req.query("limit") ?? 30);
  const limit = Math.min(Number.isFinite(raw) && raw > 0 ? raw : 30, 200);
  const res = await c.env.DB.prepare(
    `SELECT * FROM premonitions ORDER BY felt_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return c.json(res.results);
});

app.delete("/api/premonitions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const row = await c.env.DB.prepare(
    `DELETE FROM premonitions WHERE id = ? RETURNING id`
  )
    .bind(id)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/**
 * Derived premonition stats. Nothing here is stored; it is all computed by pairing
 * each premonition with the next episode that STARTS within `window_hours` of it.
 *
 *  - hit_rate     : premonitions actually followed by a headache
 *  - warning_rate : headaches that were preceded by a premonition
 *  - lead times   : how long the warning gives her
 *
 * Premonitions felt while an episode was already underway are excluded: they are
 * not premonitory. Imported episodes are eligible as the "followed by" target since
 * their start date is trustworthy even when the time is not.
 */
app.get("/api/premonitions/stats", async (c) => {
  const raw = Number(c.req.query("window_hours") ?? 24);
  const windowHours = Math.min(Math.max(Number.isFinite(raw) ? raw : 24, 1), 72);
  return c.json(await premonitionStats(c.env.DB, windowHours));
});

// Delete an episode (undo a mis-tap).
app.delete("/api/episodes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const row = await c.env.DB.prepare(
    `DELETE FROM episodes WHERE id = ? RETURNING id`
  )
    .bind(id)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// --- Day factors (control days) --------------------------------------------

// Fetch and upsert weather for a date range. Idempotent; touches no episode.
// Chunk long ranges from the caller so a single request stays inside limits.
interface BackfillBody {
  from?: string;
  to?: string;
}

app.post("/api/days/backfill", async (c) => {
  const body = await c.req.json<BackfillBody>().catch(() => ({}) as BackfillBody);
  const isDate = (v: unknown): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDate(body.from) || !isDate(body.to)) {
    return c.json({ error: "from and to must be YYYY-MM-DD" }, 400);
  }
  if (body.from > body.to) return c.json({ error: "from must be <= to" }, 400);
  try {
    return c.json(await backfillDays(c.env, body.from, body.to));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "backfill failed" }, 502);
  }
});

app.get("/api/days", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (from) { where.push("local_date >= ?"); binds.push(from); }
  if (to) { where.push("local_date <= ?"); binds.push(to); }
  const res = await c.env.DB.prepare(
    `SELECT * FROM days ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY local_date DESC LIMIT 400`
  ).bind(...binds).all();
  return c.json(res.results);
});

// Intake for on-device health factors. Health Connect has no cloud API, so an
// Android reader (or a CSV export from any source) pushes daily aggregates here.
// Idempotent, merges partial pushes, and never touches the weather columns.
interface HealthBody {
  source?: string;
  tz?: string;
  days?: unknown[];
  sleep_sessions?: Array<{ start: string; end: string }>;
}

app.post("/api/days/health", async (c) => {
  const body = await c.req.json<HealthBody>().catch(() => ({}) as HealthBody);
  const source = typeof body.source === "string" ? body.source.slice(0, 40) : "unknown";

  const incoming: unknown[] = Array.isArray(body.days) ? [...body.days] : [];

  // Sleep sessions are the natural shape from Health Connect. Aggregate them onto
  // the WAKE day: the exposure for a headache on day D is the night that ended
  // on the morning of D.
  if (Array.isArray(body.sleep_sessions) && body.sleep_sessions.length) {
    if (typeof body.tz !== "string" || !body.tz) {
      return c.json({ error: "tz is required when posting sleep_sessions" }, 400);
    }
    incoming.push(...aggregateSleepSessions(body.sleep_sessions, body.tz));
  }

  if (!incoming.length) return c.json({ error: "nothing to write" }, 400);

  const { valid, rejected } = validateHealthDays(incoming);
  if (!valid.length) return c.json({ error: "no valid rows", rejected }, 400);

  const { days_written } = await upsertHealthDays(c.env, valid, source);
  return c.json({ days_written, rejected, source });
});

app.get("/api/days/health/coverage", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT count(*) AS days_total,
            sum(sleep_minutes IS NOT NULL) AS days_with_sleep,
            sum(steps IS NOT NULL) AS days_with_steps,
            sum(resting_hr IS NOT NULL) AS days_with_resting_hr,
            sum(hrv_ms IS NOT NULL) AS days_with_hrv,
            min(CASE WHEN sleep_minutes IS NOT NULL THEN local_date END) AS first_sleep_day,
            max(CASE WHEN sleep_minutes IS NOT NULL THEN local_date END) AS last_sleep_day
       FROM days`
  ).first();
  return c.json(row);
});

// --- Cycle (F13) -----------------------------------------------------------
// One tap a month. cycle_day for every other day is DERIVED from these events,
// never stored, so a forgotten period added later corrects the whole history.

interface CycleBody {
  local_date?: string;
  note?: string;
}

app.post("/api/cycle", async (c) => {
  const body = await c.req.json<CycleBody>().catch(() => ({}) as CycleBody);
  const date = body.local_date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "local_date must be YYYY-MM-DD" }, 400);
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO cycle_events (local_date, kind, note, source)
     VALUES (?, 'period_start', ?, 'app')
     ON CONFLICT(local_date) DO UPDATE SET note = COALESCE(excluded.note, cycle_events.note)
     RETURNING *`
  )
    .bind(date, body.note ?? null)
    .first();
  return c.json(row, 201);
});

app.get("/api/cycle", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT * FROM cycle_events ORDER BY local_date DESC LIMIT 60`
  ).all();
  return c.json(res.results);
});

app.delete("/api/cycle/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const row = await c.env.DB.prepare(`DELETE FROM cycle_events WHERE id = ? RETURNING id`)
    .bind(id)
    .first<{ id: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/cycle/analysis", async (c) => c.json(await menstrualAnalysis(c.env.DB)));

// --- Dashboard + export (F5 / F6 / F7 / F8) --------------------------------

app.get("/api/summary", async (c) => c.json(await buildSummary(c.env.DB)));

app.get("/api/export/episodes.csv", async (c) => {
  const csv = await episodesCsv(c.env.DB);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="aura-episodes.csv"',
    },
  });
});

app.get("/api/export/doctor", async (c) => {
  const page = await doctorHtml(c.env.DB);
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
});

app.get("/api/export/obsidian", async (c) => {
  const md = await obsidianMarkdown(c.env.DB, nowIso());
  return new Response(md, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="Aura-snapshot.md"',
    },
  });
});

app.get("/api/triggers", async (c) => c.json(await triggerAnalysis(c.env.DB)));

app.get("/api/patterns", async (c) =>
  c.json({
    day_of_week: await dayOfWeekAnalysis(c.env.DB),
    time_of_day: await timeOfDayAnalysis(c.env.DB),
  })
);

app.get("/api/meds/response", async (c) => c.json(await medicationResponse(c.env.DB)));

// --- MCP server ------------------------------------------------------------
// Mounted before the SPA fallback so /mcp is never swallowed by index.html.
app.route("/mcp", mcp);

// --- Static SPA fallback ---------------------------------------------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Named export so tests can drive routes directly via app.request().
export { app };

export default {
  fetch: app.fetch,
  // Nightly: keep the trailing window of control days current, so weather never
  // depends on a device granting geolocation.
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(refreshRecentDays(env, 7).then(() => undefined));
  },
};

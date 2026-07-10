import { Hono } from "hono";
import type { Bindings } from "./db";
import { localDate, nowIso, upsertPeakSample, validSeverity } from "./db";
import { fetchEnrichment, roundCoord } from "./enrich";
import type { Episode, StartBody, EndBody } from "../shared/types";

const app = new Hono<{ Bindings: Bindings }>();

// --- Access guard ----------------------------------------------------------
// Every /api route except /api/health requires the bearer PIN, when one is set.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const pin = c.env.ACCESS_PIN;
  if (pin) {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token !== pin) return c.json({ error: "unauthorized" }, 401);
  }
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

  const row = await c.env.DB.prepare(
    `INSERT INTO episodes
       (started_at, local_date, started_at_time_known, tz, lat, lon,
        weather_code, pressure_hpa, temp_c, source)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'app')
     RETURNING *`
  )
    .bind(
      startedAt,
      localDate(startedAt, tz),
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

  const row = await c.env.DB.prepare(
    `UPDATE episodes
        SET ended_at = ?,
            severity = COALESCE(?, severity),
            meds     = COALESCE(?, meds),
            note     = COALESCE(?, note),
            updated_at = ?
      WHERE id = ?
      RETURNING *`
  )
    .bind(endedAt, severity, body.meds ?? null, body.note ?? null, nowIso(), id)
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

// Recent episodes, newest first.
app.get("/api/episodes", async (c) => {
  const raw = Number(c.req.query("limit") ?? 30);
  const limit = Math.min(Number.isFinite(raw) && raw > 0 ? raw : 30, 200);
  const res = await c.env.DB.prepare(
    `SELECT * FROM episodes ORDER BY started_at DESC LIMIT ?`
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
  const windowDays = windowHours / 24;

  // All time comparisons go through julianday(). SQLite's datetime() returns
  // 'YYYY-MM-DD HH:MM:SS' while our timestamps are 'YYYY-MM-DDTHH:MM:SS.sssZ';
  // comparing those as strings is wrong ('T' sorts after ' '). julianday parses
  // both and compares as numbers.
  //
  // An episode with no ended_at is assumed to run at most 72 hours, the ICHD-3
  // maximum for a migraine attack. Without that cap, one attack she forgot to
  // end would look "ongoing" forever and silently swallow every later
  // premonition from these stats.
  const paired = await c.env.DB.prepare(
    `WITH eligible AS (
       SELECT p.id, p.felt_at
         FROM premonitions p
        WHERE NOT EXISTS (
          SELECT 1 FROM episodes e
           WHERE e.source = 'app'
             AND julianday(e.started_at) <= julianday(p.felt_at)
             AND julianday(COALESCE(e.ended_at, datetime(e.started_at, '+72 hours')))
                 >= julianday(p.felt_at)
        )
     )
     SELECT g.id,
            g.felt_at,
            (SELECT min(e.started_at) FROM episodes e
              WHERE e.started_at_time_known = 1
                AND julianday(e.started_at) > julianday(g.felt_at)
                AND julianday(e.started_at) <= julianday(g.felt_at) + ?) AS next_start
       FROM eligible g`
  )
    .bind(windowDays)
    .all<{ id: number; next_start: string | null; felt_at: string }>();

  const rows = paired.results;
  const followed = rows.filter((r) => r.next_start !== null);
  const leads = followed
    .map((r) => (Date.parse(r.next_start!) - Date.parse(r.felt_at)) / 3600000)
    .sort((a, b) => a - b);

  // Only episodes with a known start time can be said to have been "warned":
  // an imported row anchored at local noon would produce a fictional lead time.
  const totalEpisodes = await c.env.DB.prepare(
    `SELECT count(*) AS n FROM episodes WHERE started_at_time_known = 1`
  ).first<{ n: number }>();
  const warned = await c.env.DB.prepare(
    `SELECT count(*) AS n FROM episodes e
      WHERE e.started_at_time_known = 1
        AND EXISTS (SELECT 1 FROM premonitions p
                     WHERE julianday(p.felt_at) < julianday(e.started_at)
                       AND julianday(e.started_at) <= julianday(p.felt_at) + ?)`
  )
    .bind(windowDays)
    .first<{ n: number }>();

  const median = leads.length
    ? leads[Math.floor((leads.length - 1) / 2)]
    : null;

  return c.json({
    window_hours: windowHours,
    premonitions_eligible: rows.length,
    followed_by_headache: followed.length,
    // Honest about power: these are meaningless on a handful of taps.
    hit_rate: rows.length ? followed.length / rows.length : null,
    warning_rate: totalEpisodes?.n ? (warned?.n ?? 0) / totalEpisodes.n : null,
    lead_hours_median: median,
    lead_hours_min: leads.length ? leads[0] : null,
    lead_hours_max: leads.length ? leads[leads.length - 1] : null,
    enough_data: rows.length >= 10 && followed.length >= 3,
  });
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

// --- Static SPA fallback ---------------------------------------------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

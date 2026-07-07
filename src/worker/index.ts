import { Hono } from "hono";
import type { Bindings } from "./db";
import { nowIso } from "./db";
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
       (started_at, tz, lat, lon, weather_code, pressure_hpa, temp_c)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING *`
  )
    .bind(startedAt, tz, lat, lon, enr.weather_code, enr.pressure_hpa, enr.temp_c)
    .first<Episode>();

  return c.json(row, 201);
});

// Close an episode, with optional severity / meds / note.
app.post("/api/episodes/:id/end", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "bad id" }, 400);
  const body = await c.req.json<EndBody>().catch(() => ({}) as EndBody);
  const endedAt = body.client_ended_at ?? nowIso();

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
    .bind(
      endedAt,
      body.severity ?? null,
      body.meds ?? null,
      body.note ?? null,
      nowIso(),
      id
    )
    .first<Episode>();

  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

// The currently-open episode (if any), so the UI knows to show "end".
app.get("/api/episodes/current", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT * FROM episodes WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
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
  return c.json(row);
});

// --- Static SPA fallback ---------------------------------------------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

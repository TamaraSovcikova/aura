// Aura MCP server: JSON-RPC 2.0 over HTTP (MCP streamable-HTTP transport).
// Mount at /mcp. Auth: Authorization: Bearer <ACCESS_PIN>, or ?token=<ACCESS_PIN>
// for cloud-brokered connectors whose UI takes a URL but no headers.
//
// This server IS the insights engine. Aura computes deterministic statistics;
// Claude reads them here and narrates. No LLM runs inside the app, so no health
// number is ever hallucinated.
//
// Because Claude narrates from these tool descriptions, the epistemic guardrails
// live in the descriptions themselves. Read them as part of the contract.

import { Hono } from "hono";
import type { Bindings } from "./db";
import { checkPin, localDate, nowIso } from "./db";
import {
  headacheDaysTrend,
  monthSeries,
  monthlyHeadacheDays,
  premonitionStats,
} from "./stats";
import { beliefVsData, premonitionConversion, triggerAnalysis } from "./triggers";
import { menstrualAnalysis } from "./cycle";
import { medicationResponse } from "./meds";
import { dayOfWeekAnalysis, timeOfDayAnalysis } from "./patterns";
import { buildSummary } from "./insights";

export const mcp = new Hono<{ Bindings: Bindings }>();

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const json = (v: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
});

// ── Tools ────────────────────────────────────────────────────────────────────

const DATA_CAVEATS = [
  "Episodes with source 'obsidian-import' came from an older diary: they have no end time (so no duration), and those with started_at_time_known = 0 have no reliable start time (anchored at local noon).",
  "These are Monthly HEADACHE Days (MHD), not Monthly MIGRAINE Days (MMD). ICHD-3 criteria cannot be checked retroactively, so no imported attack is classified as migraine.",
  "Weather does NOT live on the episode: the per-episode pressure columns are mostly NULL because geolocation was rarely granted. Day-level weather lives in the `days` table, keyed on local_date and the location timeline, and covers every day whether or not it was a headache day.",
  "Do NOT compare headache days against control days by hand: an unadjusted, unweighted, untested difference is exactly how a false trigger gets believed. Use the `trigger_analysis` tool, which stratifies by place and month and corrects for multiple comparisons, and report its `verdict` field.",
  "Sleep, steps and heart-rate data must be pushed from an Android reader (Health Connect has no cloud API). Until `control_days.days_with_sleep` is large, sleep reports 'insufficient data' and any belief that poor sleep triggers the migraines remains untestable, not disproven.",
  "Aura records and counts. It never diagnoses and never recommends treatment.",
].join(" ");

const TOOLS = [
  {
    name: "get_overview",
    description:
      "High-level summary of the user's migraine history: totals, date span, headache days per month, severity distribution, and data provenance. Start here. " +
      DATA_CAVEATS,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "monthly_headache_days",
    description:
      "Headache days per calendar month, with average peak severity. A day counts once no matter how many entries it has. This is the number a neurologist works in. " +
      "The series is contiguous: a month with zero headache days is included as 0 rather than omitted. Each month carries `complete`; when false the month was only partly observed (logging started mid-month, or the month is still running) and must NOT be compared against full months.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "inclusive YYYY-MM-DD" },
        to: { type: "string", description: "inclusive YYYY-MM-DD" },
      },
    },
  },
  {
    name: "headache_days_trend",
    description:
      "Is it getting worse? Compares the mean headache days of the last 3 COMPLETE months against the previous 3 complete months. Partial months (the current one, and the first one logged) are excluded and listed in `excluded_partial_months`, because averaging a part-month against full ones fabricates an improvement. " +
      "Reports percent change and whether it meets the >=50% reduction clinicians treat as a treatment response. This is an observation about counts, NOT a claim that any treatment worked.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_episodes",
    description:
      "Individual episodes, newest first. Includes the free-text note, peak severity (0-10), and the quarantined self-reported fields. " +
      DATA_CAVEATS,
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "inclusive YYYY-MM-DD" },
        to: { type: "string", description: "inclusive YYYY-MM-DD" },
        limit: { type: "number", description: "default 50, max 500" },
      },
    },
  },
  {
    name: "search_notes",
    description:
      "Full-text search across the free-text notes the user wrote about each attack. Useful for questions like 'when did I mention the weather?' or 'which attacks involved my eye?'",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "substring to search for, case-insensitive" },
        limit: { type: "number", description: "default 20, max 200" },
      },
      required: ["query"],
    },
  },
  {
    name: "self_reported_triggers",
    description:
      "Frequency of the trigger labels the user tagged in the imported Obsidian diary (e.g. 'Not enough sleep', 'Stress', 'Medication'). " +
      "CRITICAL: these are the user's BELIEFS, not evidence. They are self-reported, recorded only on attack days, and have no control group, so they cannot establish causation and must never be presented as established triggers. " +
      "In particular the 'Medication' tag marks that an attack was treated; it does NOT indicate medication overuse. " +
      "Their only legitimate use is to compare belief against objective data once the weather backfill exists.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "premonition_stats",
    description:
      "Derived statistics for the 'I feel one coming' signal: hit rate (share of premonitions actually followed by a headache), warning rate (share of headaches that were preceded by one), and lead-time distribution. " +
      "Premonitions felt while an attack was already underway are excluded. Check `enough_data` before drawing any conclusion; it is false until there are at least 10 eligible premonitions and 3 that were followed.",
    inputSchema: {
      type: "object",
      properties: {
        window_hours: {
          type: "number",
          description: "How long after a premonition a headache still counts as 'followed'. Default 24, max 72.",
        },
      },
    },
  },
  {
    name: "trigger_analysis",
    description:
      "Case-control test of whether objective day-level factors (barometric pressure and its 24h change, sharpest 3h fall, temperature, humidity, daylight) differ between headache days and non-headache days. " +
      "Every comparison is stratified by (place, month) so season and country cannot masquerade as a trigger, and Benjamini-Hochberg q-values control the false discovery rate across the seven factors. " +
      "READ THE `verdict` FIELD, not the raw difference. A verdict of 'no evidence of association' is a result and must be reported as one, not described as 'a slight trend'. Nothing here establishes causation, and none of it is medical advice.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "belief_vs_data",
    description:
      "Compares what the user believed triggered the migraines (their own tags: sleep, stress, late meal) against the objective data. " +
      "CRITICAL: those tags were recorded ONLY on headache days, so there is no control group for them and this CANNOT show that stress causes migraines. Always surface the `limitation` field. The only question this answers is narrower: do the days blamed on X look meteorologically different from the other headache days?",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "premonition_conversion",
    description:
      "Compares the days a premonition turned into a headache against the days it did not. Both groups share whatever produces the feeling, which makes this a cleaner contrast than headache days against normal days. Requires at least 10 of each; check `enough_data`. The false alarms are the valuable half of this data.",
    inputSchema: {
      type: "object",
      properties: { window_hours: { type: "number", description: "Default 24, max 72." } },
    },
  },
  {
    name: "summary",
    description:
      "The dashboard in one call: monthly headache days (with `complete` flags), the quarter-on-quarter trend, severity distribution, acute-medication days per month with the ICHD-3 day counts, control-day coverage, Monthly Migraine Days (`migraine_days`) plus the `classified` breakdown, and the deterministic insight cards. " +
      "`migraine_days` counts only app attacks whose recorded symptoms meet the ICHD-3 migraine criteria; the imported diary carries no symptoms and is never classified, so it contributes to headache days only. Each card carries `kind`: 'fact' is a count, 'gated' depends on a statistical test that reports its own power.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "day_of_week",
    description:
      "Does the day of the week matter? A chi-square test of whether headache incidence depends on the weekday, over every backfilled day. Returns per-day headache rates and a `verdict`. Not stratified, because weekday is near-independent of season and place. Read the `verdict`, not the raw p.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "time_of_day",
    description:
      "Do attacks cluster at a time of day? A Rayleigh test (time is circular) over attacks with a KNOWN onset time only; estimated and woken-with onsets are excluded so they cannot invent a spike. Returns the `peak_hour`, a per-period breakdown, and a `verdict`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "medication_response",
    description:
      "How well does the acute medication work? Counts and medians over logged doses: the relief rate (doses that brought relief / all logged doses), the median minutes from dose to relief, and the median residual pain (0-10) it pulled down to, overall and per named medication (>=3 doses). " +
      "A dose with NO relief logged is kept and counted as one that did not help; time-to-relief is computed only from doses that reached relief, never zero-filled. Below 3 doses it returns 'insufficient data'. Read the `verdict` and `message`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "menstrual_analysis",
    description:
      "Do headache odds differ in the perimenstrual window (day -2 to +3 around a period start)? A binary exposure, so it uses a Mantel-Haenszel odds ratio stratified by (place, month), not a difference in means. " +
      "Days whose cycle day cannot be known are excluded, never assumed. Imported history carries no cycle data, so until period starts have been logged for several months this returns 'insufficient data'. Read the `verdict`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_period_start",
    description:
      "Record that the user's period started on a given day (defaults to today). One tap a month; the cycle day of every other day is derived from these. Use only when the user says it started; never infer it.",
    inputSchema: {
      type: "object",
      properties: {
        local_date: { type: "string", description: "YYYY-MM-DD, defaults to today in Europe/Berlin" },
        note: { type: "string" },
      },
    },
  },
  {
    name: "log_premonition",
    description:
      "Record that the user feels a migraine coming, right now. Writes a timestamped premonition. Use only when the user says one is coming; never infer it.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "optional free text about the feeling" },
        tz: { type: "string", description: "IANA timezone, defaults to Europe/Berlin" },
      },
    },
  },
] as const;

// ── Tool implementations ─────────────────────────────────────────────────────

/**
 * The window over which we can say a month had N headache days.
 *
 * It ends at her LAST recorded episode, not today. Zero-filling to "now" would
 * invent migraine-free months out of a simple absence of data: a gap between two
 * recorded episodes is a real zero (she was logging on both sides), but the
 * trailing gap after her last entry is unknown, not zero.
 */
async function observedSpan(db: D1Database): Promise<{ first: string | null; last: string | null }> {
  const r = await db
    .prepare(`SELECT min(local_date) AS first, max(local_date) AS last FROM episodes`)
    .first<{ first: string | null; last: string | null }>();
  return { first: r?.first ?? null, last: r?.last ?? null };
}

async function handleTool(
  name: string,
  args: Record<string, unknown>,
  env: Bindings
): Promise<unknown> {
  const db = env.DB;

  switch (name) {
    case "get_overview": {
      const totals = await db
        .prepare(
          `SELECT count(*) AS episodes,
                  count(DISTINCT local_date) AS headache_days,
                  min(local_date) AS first_day,
                  max(local_date) AS last_day,
                  sum(CASE WHEN source = 'obsidian-import' THEN 1 ELSE 0 END) AS imported,
                  sum(CASE WHEN source = 'app' THEN 1 ELSE 0 END) AS captured_in_app,
                  sum(CASE WHEN started_at_time_known = 1 THEN 1 ELSE 0 END) AS with_known_start_time,
                  round(avg(severity), 2) AS mean_peak_severity
             FROM episodes`
        )
        .first();
      const span = await observedSpan(db);
      const series = monthSeries(await monthlyHeadacheDays(db), span.first, span.last ?? "");
      const complete = series.filter((m) => m.complete);
      const dist = await db
        .prepare(
          `SELECT severity, count(*) AS n FROM episodes
            WHERE severity IS NOT NULL GROUP BY severity ORDER BY severity`
        )
        .all();
      const prem = await db.prepare(`SELECT count(*) AS n FROM premonitions`).first<{ n: number }>();
      const health = await db
        .prepare(
          `SELECT count(*) AS control_days,
                  sum(sleep_minutes IS NOT NULL) AS days_with_sleep,
                  sum(steps IS NOT NULL) AS days_with_steps,
                  sum(resting_hr IS NOT NULL) AS days_with_resting_hr
             FROM days`
        )
        .first();
      // Averaged over COMPLETE months only, and zero-headache months are counted
      // (a GROUP BY would drop them, inflating the mean).
      const meanMhd = complete.length
        ? Number((complete.reduce((s, m) => s + m.headache_days, 0) / complete.length).toFixed(1))
        : null;
      return json({
        ...totals,
        months_covered: series.length,
        complete_months: complete.length,
        mean_headache_days_per_month_complete_months_only: meanMhd,
        severity_distribution: dist.results,
        premonitions_logged: prem?.n ?? 0,
        control_days: health,
        caveats: DATA_CAVEATS,
      });
    }

    case "monthly_headache_days": {
      const rows = await monthlyHeadacheDays(
        db,
        args.from as string | undefined,
        args.to as string | undefined
      );
      const span = await observedSpan(db);
      const from = (args.from as string | undefined) ?? span.first;
      const to = (args.to as string | undefined) ?? span.last ?? "";
      return json(monthSeries(rows, from, to));
    }

    case "headache_days_trend": {
      const span = await observedSpan(db);
      return json(
        headacheDaysTrend(monthSeries(await monthlyHeadacheDays(db), span.first, span.last ?? ""))
      );
    }

    case "list_episodes": {
      const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 500);
      const where: string[] = [];
      const binds: unknown[] = [];
      if (args.from) {
        where.push("local_date >= ?");
        binds.push(args.from);
      }
      if (args.to) {
        where.push("local_date <= ?");
        binds.push(args.to);
      }
      binds.push(limit);
      const rows = await db
        .prepare(
          `SELECT id, local_date, started_at, started_at_time_known, ended_at, severity,
                  meds, note, self_reported_triggers, self_reported_type, onset_raw,
                  pressure_hpa, temp_c, source
             FROM episodes
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY local_date DESC LIMIT ?`
        )
        .bind(...binds)
        .all();
      return json(rows.results);
    }

    case "search_notes": {
      const q = String(args.query ?? "").trim();
      if (!q) throw new Error("query is required");
      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200);
      const rows = await db
        .prepare(
          `SELECT id, local_date, severity, note FROM episodes
            WHERE note IS NOT NULL AND lower(note) LIKE '%' || lower(?) || '%'
            ORDER BY local_date DESC LIMIT ?`
        )
        .bind(q, limit)
        .all();
      return json({ query: q, matches: rows.results.length, results: rows.results });
    }

    case "self_reported_triggers": {
      const rows = await db
        .prepare(
          `SELECT self_reported_triggers AS t FROM episodes
            WHERE self_reported_triggers IS NOT NULL AND self_reported_triggers <> ''`
        )
        .all<{ t: string }>();
      const counts = new Map<string, number>();
      for (const r of rows.results) {
        for (const tag of r.t.split(";").map((s) => s.trim()).filter(Boolean)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      const sorted = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([trigger, count]) => ({ trigger, count }));
      return json({
        episodes_with_tags: rows.results.length,
        triggers: sorted,
        warning:
          "These are self-reported beliefs recorded only on attack days. There is no control group, so they cannot establish causation. Do not present them as established triggers.",
      });
    }

    case "premonition_stats": {
      const raw = Number(args.window_hours ?? 24);
      const w = Math.min(Math.max(Number.isFinite(raw) ? raw : 24, 1), 72);
      return json(await premonitionStats(db, w));
    }

    case "trigger_analysis":
      return json(await triggerAnalysis(db));

    case "belief_vs_data":
      return json(await beliefVsData(db));

    case "premonition_conversion": {
      const raw = Number(args.window_hours ?? 24);
      const w = Math.min(Math.max(Number.isFinite(raw) ? raw : 24, 1), 72);
      return json(await premonitionConversion(db, w));
    }

    case "summary":
      return json(await buildSummary(db));

    case "medication_response":
      return json(await medicationResponse(db));

    case "menstrual_analysis":
      return json(await menstrualAnalysis(db));

    case "day_of_week":
      return json(await dayOfWeekAnalysis(db));

    case "time_of_day":
      return json(await timeOfDayAnalysis(db));

    case "log_period_start": {
      const date = (args.local_date as string | undefined) ?? localDate(nowIso(), "Europe/Berlin");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("local_date must be YYYY-MM-DD");
      const row = await db
        .prepare(
          `INSERT INTO cycle_events (local_date, kind, note, source)
           VALUES (?, 'period_start', ?, 'mcp')
           ON CONFLICT(local_date) DO UPDATE SET note = COALESCE(excluded.note, cycle_events.note)
           RETURNING *`
        )
        .bind(date, (args.note as string | undefined) ?? null)
        .first();
      return json({ logged: row });
    }

    case "log_premonition": {
      const feltAt = nowIso();
      const tz = (args.tz as string | undefined) ?? "Europe/Berlin";
      const row = await db
        .prepare(
          `INSERT INTO premonitions (felt_at, local_date, note, tz, source)
           VALUES (?, ?, ?, ?, 'mcp') RETURNING *`
        )
        .bind(feltAt, localDate(feltAt, tz), (args.note as string | undefined) ?? null, tz)
        .first();
      return json({ logged: row });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC transport ───────────────────────────────────────────────────────

mcp.post("/", async (c) => {
  const auth = checkPin(c.env.ACCESS_PIN, c.req.header("Authorization"), c.req.query("token"));
  if (auth === "misconfigured") {
    console.error("ACCESS_PIN is not set, refusing MCP requests. Set the secret and redeploy.");
    return c.json(err(null, -32000, "Server misconfigured"), 503);
  }
  if (auth === "unauthorized") return c.json(err(null, -32000, "Unauthorized"), 401);

  let body: { jsonrpc: string; id: unknown; method: string; params?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json(err(null, -32700, "Parse error"), 400);
  }

  const { id, method, params = {} } = body;

  if (method === "initialize") {
    return c.json(
      ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "aura", version: "1.0.0" },
      })
    );
  }

  if (method === "tools/list") return c.json(ok(id, { tools: TOOLS }));

  if (method === "tools/call") {
    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      return c.json(ok(id, await handleTool(toolName, toolArgs, c.env)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      return c.json(
        ok(id, { content: [{ type: "text", text: `Error: ${msg}` }], isError: true })
      );
    }
  }

  // notifications/* expect no response body.
  if (method.startsWith("notifications/")) return c.body(null, 204);

  return c.json(err(id, -32601, `Method not found: ${method}`), 404);
});

mcp.get("/", (c) =>
  c.json({
    name: "aura",
    transport: "streamable-http",
    tools: TOOLS.map((t) => t.name),
  })
);

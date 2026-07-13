import type { Context } from "hono";
import type { EndBody } from "../shared/types";
import { deriveSide } from "../shared/headmap";

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  // Shared PIN. Client sends `Authorization: Bearer <ACCESS_PIN>`. When unset,
  // the Worker allows all requests (local dev convenience).
  ACCESS_PIN: string | undefined;
};

export type AppContext = Context<{ Bindings: Bindings }>;

export const nowIso = () => new Date().toISOString();

/**
 * The calendar day an instant falls on in `tz`. All day-based metrics (monthly
 * headache days) group by this, never by the UTC date, so a 23:00 BST attack
 * cannot silently land on the previous day.
 */
export function localDate(iso: string, tz: string | null | undefined): string {
  if (!tz) return iso.slice(0, 10);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** Severity is a 0-10 VAS. Returns the value, or null when absent/invalid. */
export function validSeverity(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10) return null;
  return v;
}

/**
 * SQL SET fragments for the ICHD-3 attributes present in a request body, shared by
 * the end and patch handlers so the two write them identically. Booleans become
 * 0/1, `pain_regions` is stored as JSON, and `side` is derived from the painted
 * regions when they are supplied (an explicit `side` still wins). A field absent
 * from the body is not touched; a field sent as null is cleared on purpose.
 */
export function attributeUpdates(body: EndBody): { sets: string[]; vals: unknown[] } {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const bool = (v: boolean | null | undefined) => (v == null ? null : v ? 1 : 0);

  const textFields = ["side", "quality"] as const;
  for (const f of textFields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      vals.push(body[f] ?? null);
    }
  }
  const boolFields = [
    "aggravated_by_activity",
    "nausea",
    "photophobia",
    "phonophobia",
    "aura",
  ] as const;
  for (const f of boolFields) {
    if (f in body) {
      sets.push(`${f} = ?`);
      vals.push(bool(body[f]));
    }
  }

  if ("pain_regions" in body) {
    const regions = body.pain_regions ?? null;
    sets.push("pain_regions = ?");
    vals.push(regions ? JSON.stringify(regions) : null);
    // Derive laterality from the map unless the caller set `side` explicitly.
    if (!("side" in body) && regions) {
      sets.push("side = ?");
      vals.push(deriveSide(regions));
    }
  }
  return { sets, vals };
}

/** Replace the episode's peak severity sample. Peak-per-day is derived from these. */
export async function upsertPeakSample(
  db: D1Database,
  episodeId: number,
  level: number,
  ts: string | null
): Promise<void> {
  await db
    .prepare(`DELETE FROM severity_samples WHERE episode_id = ? AND kind = 'peak'`)
    .bind(episodeId)
    .run();
  await db
    .prepare(
      `INSERT INTO severity_samples (episode_id, ts, level, kind) VALUES (?, ?, ?, 'peak')`
    )
    .bind(episodeId, ts, level)
    .run();
}

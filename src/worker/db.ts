import type { Context } from "hono";

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

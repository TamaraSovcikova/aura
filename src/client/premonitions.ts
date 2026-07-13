// Offline-safe queue for premonition taps.
//
// A premonition is fire-and-forget: one timestamp, no end, no follow-up. But the
// tap must never be lost to a dead connection, because unlike weather (which F4
// can backfill from an archive) a premonition cannot be reconstructed from
// anything. If it isn't captured the moment she feels it, it is gone.

export interface LocalPremonition {
  localId: string;
  felt_at: string;
  lat: number | null;
  lon: number | null;
  tz: string | null;
  synced: boolean;
}

const KEY = "aura_prem_outbox";

export function loadPremOutbox(): LocalPremonition[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v as LocalPremonition[]) : [];
  } catch {
    return [];
  }
}

export function savePremOutbox(list: LocalPremonition[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function newPremonition(input: {
  felt_at: string;
  lat: number | null;
  lon: number | null;
  tz: string | null;
}): LocalPremonition {
  return { localId: crypto.randomUUID(), synced: false, ...input };
}

export type SendPremFn = (p: LocalPremonition) => Promise<void>;

// In-flight POSTs keyed by localId, shared across every concurrent reconcile pass.
//
// The `synced` flag alone cannot make a send idempotent under concurrency: two
// passes (e.g. a launch deep-link firing onPremonition() while the initial flush
// effect runs) each load their own copy of the outbox, so they hold distinct
// record objects that share a localId, and neither sees the other set `synced`.
// This module-level map is the shared guard. The first pass to reach a record
// registers its POST here *before* awaiting it, so a racing pass coalesces onto the
// same promise instead of sending a duplicate. Cleared once settled so a genuine
// retry (after a failed send) can run on a later pass.
const inFlight = new Map<string, Promise<void>>();

/**
 * Push queued premonitions. Each is POSTed at most once, even when two reconcile
 * passes run concurrently (guarded by `synced` across passes and by `inFlight`
 * within a race), so a retry or a launch race can never create a duplicate signal,
 * which would inflate the hit rate. Synced rows are dropped; anything that failed
 * is kept for next time.
 */
export async function reconcilePremonitions(
  list: LocalPremonition[],
  send: SendPremFn
): Promise<LocalPremonition[]> {
  const keep: LocalPremonition[] = [];
  for (const p of list) {
    if (p.synced) continue;
    try {
      // Coalesce with a concurrent pass already sending this record; otherwise
      // start the POST and publish it before awaiting, so a racing pass joins in.
      const existing = inFlight.get(p.localId);
      const flight = existing ?? send(p);
      if (!existing) inFlight.set(p.localId, flight);
      try {
        await flight;
      } finally {
        if (!existing) inFlight.delete(p.localId);
      }
      p.synced = true;
    } catch (err) {
      if (err instanceof Error && err.name === "UnauthorizedError") throw err;
      keep.push(p);
    }
  }
  return keep;
}

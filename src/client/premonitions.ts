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

/**
 * Push queued premonitions. Each is POSTed at most once (guarded by `synced`),
 * so a retry can never create a duplicate signal, which would inflate the hit
 * rate. Synced rows are dropped; anything that failed is kept for next time.
 */
export async function reconcilePremonitions(
  list: LocalPremonition[],
  send: SendPremFn
): Promise<LocalPremonition[]> {
  const keep: LocalPremonition[] = [];
  for (const p of list) {
    if (p.synced) continue;
    try {
      await send(p);
      p.synced = true;
    } catch (err) {
      if (err instanceof Error && err.name === "UnauthorizedError") throw err;
      keep.push(p);
    }
  }
  return keep;
}

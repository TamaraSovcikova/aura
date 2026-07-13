import type { EndBody } from "../shared/types";
import type { Attrs } from "./SymptomDetails";

// A migraine episode captured on the device. Lives in localStorage until it is
// fully synced to the server, so a log is never lost to a dead connection.
export interface LocalEpisode {
  localId: string;
  serverId: number | null;
  started_at: string;
  ended_at: string | null;
  /** False once the start has been backdated or marked woken-with: an estimate. */
  time_known: boolean;
  lat: number | null;
  lon: number | null;
  tz: string | null;
  severity: number | null;
  meds: string | null;
  note: string | null;
  /** Optional ICHD-3 attributes captured in the end panel; null until provided. */
  attrs: Attrs | null;
  startedSynced: boolean;
  endedSynced: boolean;
}

const KEY = "aura_outbox";

export function loadOutbox(): LocalEpisode[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v as LocalEpisode[]) : [];
  } catch {
    return [];
  }
}

export function saveOutbox(list: LocalEpisode[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function newLocalEpisode(input: {
  started_at: string;
  lat: number | null;
  lon: number | null;
  tz: string | null;
}): LocalEpisode {
  return {
    localId: crypto.randomUUID(),
    serverId: null,
    started_at: input.started_at,
    ended_at: null,
    time_known: true,
    lat: input.lat,
    lon: input.lon,
    tz: input.tz,
    severity: null,
    meds: null,
    note: null,
    attrs: null,
    startedSynced: false,
    endedSynced: false,
  };
}

/** The single open (un-ended) episode, if one exists. */
export function findOpen(list: LocalEpisode[]): LocalEpisode | undefined {
  return list.find((e) => e.ended_at == null);
}

export type StartFn = (e: LocalEpisode) => Promise<number>;
export type EndFn = (serverId: number, body: EndBody) => Promise<void>;

/**
 * Flush queued episodes to the server. A start is POSTed at most once (guarded
 * by `startedSynced`), so retries never create duplicate rows. A record is
 * dropped only once both start and end are synced; ongoing episodes and any
 * that failed to sync are retained for the next attempt.
 */
export async function reconcile(
  list: LocalEpisode[],
  startFn: StartFn,
  endFn: EndFn
): Promise<LocalEpisode[]> {
  const keep: LocalEpisode[] = [];
  for (const e of list) {
    try {
      if (!e.startedSynced) {
        e.serverId = await startFn(e);
        e.startedSynced = true;
      }
      if (e.ended_at && !e.endedSynced && e.serverId != null) {
        await endFn(e.serverId, {
          client_ended_at: e.ended_at,
          severity: e.severity ?? undefined,
          meds: e.meds ?? undefined,
          note: e.note ?? undefined,
          // Attributes ride the same end call, so an offline log syncs them too.
          ...(e.attrs
            ? {
                pain_regions: e.attrs.pain_regions,
                quality: e.attrs.quality,
                aggravated_by_activity: e.attrs.aggravated_by_activity,
                nausea: e.attrs.nausea,
                photophobia: e.attrs.photophobia,
                phonophobia: e.attrs.phonophobia,
                aura: e.attrs.aura,
              }
            : {}),
        });
        e.endedSynced = true;
      }
    } catch (err) {
      // Surface auth failures so the UI can re-prompt for the PIN; treat every
      // other error as a transient network problem and keep the record.
      if (err instanceof Error && err.name === "UnauthorizedError") throw err;
      keep.push(e);
      continue;
    }
    if (!(e.startedSynced && e.endedSynced)) keep.push(e);
  }
  return keep;
}

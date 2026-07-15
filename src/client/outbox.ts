import type { EndBody, DoseBody, ReliefBody } from "../shared/types";
import type { Attrs } from "./SymptomDetails";

// A medication dose logged mid-attack. Rides the same outbox as its episode so a
// dose (and its later "I feel better") is never lost to a dead connection. It can
// only be POSTed once its episode has a server id, so it waits in the record until
// the episode start has synced.
export interface LocalDose {
  localId: string;
  serverId: number | null;
  name: string | null;
  taken_at: string;
  /** Null until she taps "I feel better"; that gap means the dose did not help. */
  relief_at: string | null;
  relief_severity: number | null;
  takenSynced: boolean;
  reliefSynced: boolean;
}

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
  /** Medication doses taken during the attack; each syncs independently. */
  doses: LocalDose[];
  startedSynced: boolean;
  endedSynced: boolean;
}

export function newLocalDose(input: { name: string | null; taken_at: string }): LocalDose {
  return {
    localId: crypto.randomUUID(),
    serverId: null,
    name: input.name,
    taken_at: input.taken_at,
    relief_at: null,
    relief_severity: null,
    takenSynced: false,
    reliefSynced: false,
  };
}

/** A dose is done syncing once the dose itself is up and, if relief was recorded,
 *  that is up too. A dose with no relief_at is fully synced after just the POST. */
function doseSynced(d: LocalDose): boolean {
  return d.takenSynced && (d.relief_at == null || d.reliefSynced);
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
    doses: [],
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
export type DoseFn = (episodeServerId: number, body: DoseBody) => Promise<number>;
export type ReliefFn = (doseServerId: number, body: ReliefBody) => Promise<void>;

/**
 * Flush queued episodes to the server. A start is POSTed at most once (guarded
 * by `startedSynced`), so retries never create duplicate rows. Medication doses
 * ride along: each is POSTed once its episode has a server id, and its later
 * relief once the dose does. A record is dropped only once its start, end, and
 * every dose are synced; ongoing episodes, pending doses, and anything that
 * failed to sync are retained for the next attempt.
 */
export async function reconcile(
  list: LocalEpisode[],
  startFn: StartFn,
  endFn: EndFn,
  doseFn?: DoseFn,
  reliefFn?: ReliefFn
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
      // Doses need the episode's server id, so they only flush after the start has.
      if (e.serverId != null && doseFn && reliefFn) {
        for (const d of e.doses) {
          if (!d.takenSynced) {
            d.serverId = await doseFn(e.serverId, {
              name: d.name,
              client_taken_at: d.taken_at,
            });
            d.takenSynced = true;
          }
          if (d.relief_at && !d.reliefSynced && d.serverId != null) {
            await reliefFn(d.serverId, {
              relief_severity: d.relief_severity ?? undefined,
              client_relief_at: d.relief_at,
            });
            d.reliefSynced = true;
          }
        }
      }
    } catch (err) {
      // Surface auth failures so the UI can re-prompt for the PIN; treat every
      // other error as a transient network problem and keep the record.
      if (err instanceof Error && err.name === "UnauthorizedError") throw err;
      keep.push(e);
      continue;
    }
    const dosesDone = e.doses.every(doseSynced);
    if (!(e.startedSynced && e.endedSynced && dosesDone)) keep.push(e);
  }
  return keep;
}

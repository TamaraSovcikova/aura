// THE time module. Every surface that shows or edits a time goes through here.
//
// Before this existed, four different formatters were in use (clockHM on the live
// screen, toLocaleString in the history list, datetime-local in the edit sheet, plus
// ad-hoc ternaries for "ongoing"), and the estimate marker was attached to the
// DURATION while the start time next to it was printed as though it were exact. One
// row could read exact on the left and approximate on the right.
//
// The rules, in one place:
//   1. One clock format, one day+clock format. Nothing invents its own.
//   2. The estimate marker "~" attaches to the TIME IT QUALIFIES, and to anything
//      derived from it. An estimated onset is never printed as an exact clock time.
//   3. A time that is not known is labelled, never blank and never zero: an attack
//      still running is "ongoing"; an imported row with no end is "unknown".
//   4. Editing a time uses one representation (a local datetime input), everywhere.

import { durationMs, formatDuration } from "../shared/format";

export const nowIso = () => new Date().toISOString();

export const minusMinutes = (iso: string, m: number) =>
  new Date(Date.parse(iso) - m * 60_000).toISOString();

/** The estimate marker. One symbol, one meaning: "this time is approximate". */
export const ESTIMATE = "~";

/** `14:45`. The only clock format in the app. */
export const clockHM = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** `15 Jul`. The only short-date format in the app. */
export const dayShort = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/** `15 Jul, 14:45`. Composed from the two above so there is one source for each half.
 *  Kept separate because the estimate marker applies to the clock, never the date:
 *  a backdated onset still lands on an exactly-known day. */
export const dayClock = (iso: string) => `${dayShort(iso)}, ${clockHM(iso)}`;

/** Prefix a rendered time with the estimate marker when it is not exactly known. */
export const marked = (text: string, known: boolean): string =>
  known ? text : `${ESTIMATE}${text}`;

/**
 * ISO instant -> the value a <input type="datetime-local"> expects, in the device's
 * local time. Editing is rare and almost always done in the same zone the attack
 * occurred, and the server recomputes local_date from the episode's stored tz
 * regardless, so the device zone here is a safe approximation.
 */
export const isoToLocalInput = (iso: string): string => {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};

export const localInputToIso = (v: string): string | null => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Just the `HH:MM` portion of a local datetime-input value, for a time-only field. */
export const localInputTimePart = (v: string): string => v.slice(11, 16);

/** Build an ISO from a typed `HH:MM` on the same calendar day as `onIso`. */
export const isoWithClock = (onIso: string, hhmm: string): string | null => {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return null;
  return localInputToIso(`${isoToLocalInput(onIso).slice(0, 10)}T${hhmm}`);
};

/** Why an attack has no end time. They are not the same thing and must not render alike. */
export type EndState = "ended" | "ongoing" | "unknown";

export function endState(
  endedAt: string | null | undefined,
  source: string | undefined
): EndState {
  if (endedAt) return "ended";
  // Only an app capture can still be running. An imported diary row has no end time
  // because the diary never recorded one, not because the migraine never stopped.
  return source === undefined || source === "app" ? "ongoing" : "unknown";
}

/** Everything a surface needs to render one attack's times, decided in one place. */
export interface AttackTimes {
  /** `14:45`, marked when the onset is an estimate. */
  start: string;
  /** `15 Jul, 14:45`, marked when the onset is an estimate. */
  startFull: string;
  /** `21:02`, or "ongoing" / "unknown" when there is no end time. */
  end: string;
  /** `14:45 -> 21:02`. The pair, always shown together. */
  range: string;
  /** `6h 2m`, marked when derived from an estimated onset; null when not computable. */
  duration: string | null;
  endState: EndState;
  estimated: boolean;
}

export function attackTimes(e: {
  started_at: string;
  ended_at?: string | null;
  started_at_time_known?: number | boolean | null;
  source?: string;
}): AttackTimes {
  // Absent means known: only an explicit 0/false marks an estimate. Records written
  // before the flag existed were all real taps.
  const known = e.started_at_time_known === undefined || e.started_at_time_known === null
    ? true
    : Boolean(e.started_at_time_known);
  const state = endState(e.ended_at, e.source);

  const start = marked(clockHM(e.started_at), known);
  // The marker goes on the clock only. "~20 Jul, 07:26" would claim the DAY is a
  // guess, when an estimated onset still has the right day.
  const startFull = `${dayShort(e.started_at)}, ${start}`;
  const end =
    state === "ended" ? clockHM(e.ended_at as string) : state === "ongoing" ? "ongoing" : "unknown";
  const duration =
    state === "ended"
      ? marked(formatDuration(durationMs(e.started_at, e.ended_at as string)), known)
      : null;

  return {
    start,
    startFull,
    end,
    range: `${start} → ${end}`,
    duration,
    endState: state,
    estimated: !known,
  };
}

// Re-exported so a caller never reaches past this module for a duration.
export { durationMs, formatDuration };

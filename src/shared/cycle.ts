// F13: menstrual cycle. Pure derivation, no I/O.
//
// The trick that makes this worth one tap a month: from a handful of period-start
// dates, the cycle day of EVERY calendar day in between is derivable. So the
// exposure exists for control days too, without her logging anything daily. Same
// shape as the weather.
//
// What is NOT derivable: anything before her first logged period, anything after
// her last one, and anything inside an implausibly long gap (a missed log, not a
// 90-day cycle). Those days return null and are simply excluded, never guessed.

/** Longest gap between period starts we will treat as one real cycle. */
export const MAX_CYCLE_DAYS = 45;

/** The perimenstrual window used in the migraine literature: day -2 to +3. */
export const WINDOW_BEFORE = 2;
export const WINDOW_AFTER = 3;

const dayMs = 86400000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const diffDays = (a: string, b: string) => Math.round((toMs(a) - toMs(b)) / dayMs);

export interface CycleContext {
  /** 1 on the day the period started. Null when it cannot be known. */
  cycle_day: number | null;
  /** Days until the next period starts. Null if there is no later start. */
  days_to_next_start: number | null;
  /**
   * Day -2 to +3 around a period start. Null when the cycle day is unknown, or
   * when the day sits near the END of a cycle whose next start is not yet logged
   * (we cannot know it was not perimenstrual).
   */
  perimenstrual: boolean | null;
}

/**
 * Cycle context for one date, given the sorted list of period-start dates.
 *
 * Never guesses. A date before the first start, after the last start, or inside a
 * gap longer than MAX_CYCLE_DAYS returns nulls.
 */
export function cycleContext(date: string, sortedStarts: string[]): CycleContext {
  const none: CycleContext = { cycle_day: null, days_to_next_start: null, perimenstrual: null };
  if (!sortedStarts.length) return none;

  // Latest start on or before `date`.
  let prev: string | null = null;
  let next: string | null = null;
  for (const s of sortedStarts) {
    if (s <= date) prev = s;
    else {
      next = s;
      break;
    }
  }
  if (!prev) return none; // before she started logging

  const sinceStart = diffDays(date, prev);
  const nextGap = next ? diffDays(next, prev) : null;

  // A gap this long means she missed a log, not that her cycle was 60 days.
  if (nextGap !== null && nextGap > MAX_CYCLE_DAYS) return none;
  // Trailing edge: no next start recorded, and we are already past a plausible cycle.
  if (next === null && sinceStart > MAX_CYCLE_DAYS) return none;

  const cycleDay = sinceStart + 1; // day 1 is the day it started
  const toNext = next ? diffDays(next, date) : null;

  const afterOnset = cycleDay >= 1 && cycleDay <= WINDOW_AFTER;
  const beforeNext = toNext !== null && toNext >= 1 && toNext <= WINDOW_BEFORE;

  let perimenstrual: boolean | null;
  if (afterOnset || beforeNext) perimenstrual = true;
  else if (toNext === null) {
    // Cannot rule out that the next period is about to begin.
    perimenstrual = null;
  } else perimenstrual = false;

  return { cycle_day: cycleDay, days_to_next_start: toNext, perimenstrual };
}

/** Sorted, de-duplicated period-start dates. */
export function normalizeStarts(dates: string[]): string[] {
  return [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
}

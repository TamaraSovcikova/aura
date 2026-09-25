// On-device health factors: intake shaping and validation. Pure, no I/O.
//
// The main decision here: which day does a night's sleep belong to?
//
// The exposure for a headache on day D is the night that ENDED on the morning of
// D, not the night that began on D. Attributing sleep to the day she fell asleep
// would shift every value one day out of phase with the outcome, and nothing would
// visibly break. So sleep is always keyed on the WAKE day.

export interface SleepSession {
  /** ISO 8601 instant she fell asleep. */
  start: string;
  /** ISO 8601 instant she woke. */
  end: string;
}

export interface HealthDay {
  local_date: string;
  sleep_minutes?: number | null;
  sleep_efficiency?: number | null;
  steps?: number | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
}

/** Calendar day of an instant in `tz`. en-CA formats as YYYY-MM-DD. */
export function localDateInTz(iso: string, tz: string): string {
  try {
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

/** The day a night's sleep belongs to: the day she woke up. */
export function sleepDayFor(session: SleepSession, tz: string): string {
  return localDateInTz(session.end, tz);
}

const MAX_SESSION_MINUTES = 24 * 60;

/**
 * Sum sleep sessions onto their wake day. Naps on the same day add to that day.
 * A session with a non-positive or absurd duration is dropped rather than
 * clamped: a bad reading should shrink the data, never distort it.
 */
export function aggregateSleepSessions(
  sessions: SleepSession[],
  tz: string
): HealthDay[] {
  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const startMs = Date.parse(s.start);
    const endMs = Date.parse(s.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const minutes = (endMs - startMs) / 60000;
    if (minutes <= 0 || minutes > MAX_SESSION_MINUTES) continue;
    const day = sleepDayFor(s, tz);
    byDay.set(day, (byDay.get(day) ?? 0) + minutes);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([local_date, m]) => ({
      local_date,
      sleep_minutes: Math.round(Math.min(m, MAX_SESSION_MINUTES)),
    }));
}

const inRange = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

export interface ValidationResult {
  valid: HealthDay[];
  rejected: Array<{ local_date: unknown; reason: string }>;
}

/**
 * Keep only values that are physiologically possible. An out-of-range reading is
 * dropped with a reason rather than stored: a resting heart rate of 0, or 30 hours
 * of sleep, is a broken sensor, and averaging it in would move a real conclusion.
 */
export function validateHealthDays(input: unknown[]): ValidationResult {
  const valid: HealthDay[] = [];
  const rejected: Array<{ local_date: unknown; reason: string }> = [];

  for (const raw of input) {
    const d = raw as Record<string, unknown>;
    const date = d.local_date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      rejected.push({ local_date: date, reason: "local_date must be YYYY-MM-DD" });
      continue;
    }

    const day: HealthDay = { local_date: date };
    let any = false;

    const sleep = inRange(d.sleep_minutes, 0, MAX_SESSION_MINUTES);
    if (d.sleep_minutes !== undefined && d.sleep_minutes !== null) {
      if (sleep === null) {
        rejected.push({ local_date: date, reason: "sleep_minutes out of range 0..1440" });
        continue;
      }
      day.sleep_minutes = Math.round(sleep);
      any = true;
    }

    const eff = inRange(d.sleep_efficiency, 0, 1);
    if (d.sleep_efficiency !== undefined && d.sleep_efficiency !== null) {
      if (eff === null) {
        rejected.push({ local_date: date, reason: "sleep_efficiency out of range 0..1" });
        continue;
      }
      day.sleep_efficiency = eff;
      any = true;
    }

    const steps = inRange(d.steps, 0, 200000);
    if (d.steps !== undefined && d.steps !== null) {
      if (steps === null) {
        rejected.push({ local_date: date, reason: "steps out of range 0..200000" });
        continue;
      }
      day.steps = Math.round(steps);
      any = true;
    }

    const hr = inRange(d.resting_hr, 20, 250);
    if (d.resting_hr !== undefined && d.resting_hr !== null) {
      if (hr === null) {
        rejected.push({ local_date: date, reason: "resting_hr out of range 20..250" });
        continue;
      }
      day.resting_hr = Math.round(hr);
      any = true;
    }

    const hrv = inRange(d.hrv_ms, 0, 500);
    if (d.hrv_ms !== undefined && d.hrv_ms !== null) {
      if (hrv === null) {
        rejected.push({ local_date: date, reason: "hrv_ms out of range 0..500" });
        continue;
      }
      day.hrv_ms = hrv;
      any = true;
    }

    if (!any) {
      rejected.push({ local_date: date, reason: "no health values supplied" });
      continue;
    }
    valid.push(day);
  }

  return { valid, rejected };
}

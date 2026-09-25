// Pure aggregation of an Open-Meteo archive response into per-day factors.
//
// These are the CONTROL days. Trigger statistics need the days she did not get a
// migraine, and they are reconstructed here from an objective archive rather than
// demanded from her as daily logging.
//
// No network, no clock, no database. Everything here is testable.

export interface ArchiveHourly {
  time: string[]; // local wall-clock, "YYYY-MM-DDTHH:MM"
  surface_pressure: (number | null)[];
  temperature_2m?: (number | null)[];
  relative_humidity_2m?: (number | null)[];
}

export interface ArchiveDaily {
  time: string[]; // "YYYY-MM-DD"
  weather_code?: (number | null)[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  daylight_duration?: (number | null)[]; // seconds
}

export interface DayFactors {
  local_date: string;
  pressure_mean_hpa: number | null;
  pressure_min_hpa: number | null;
  pressure_max_hpa: number | null;
  /** Change in daily mean pressure vs the previous day. Null on the first day. */
  pressure_delta_24h: number | null;
  /** Most negative 3-hour pressure change starting within this day. */
  pressure_drop_max_3h: number | null;
  temp_mean_c: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
  humidity_mean: number | null;
  weather_code: number | null;
  daylight_hours: number | null;
  dow: number; // 0 = Sunday
}

const round = (v: number | null, dp = 2): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));

const mean = (a: number[]): number | null =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

/** Day of week for a local calendar date. 0 = Sunday. */
export function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/**
 * Aggregate an archive response into one row per local day.
 *
 * `previousDayMeanPressure` seeds `pressure_delta_24h` for the first day of a
 * block, so a location change (or a chunked backfill) does not silently produce a
 * null delta on the boundary day.
 *
 * The 3-hour drop is computed across the CONTINUOUS hourly series, so a pressure
 * fall that straddles midnight is still detected; it is attributed to the day the
 * fall began.
 */
export function aggregateDays(
  hourly: ArchiveHourly,
  daily: ArchiveDaily | undefined,
  previousDayMeanPressure: number | null = null
): DayFactors[] {
  const byDay = new Map<string, { p: number[]; t: number[]; h: number[] }>();
  const order: string[] = [];

  for (let i = 0; i < hourly.time.length; i++) {
    const day = hourly.time[i].slice(0, 10);
    if (!byDay.has(day)) {
      byDay.set(day, { p: [], t: [], h: [] });
      order.push(day);
    }
    const b = byDay.get(day)!;
    const p = hourly.surface_pressure[i];
    if (typeof p === "number") b.p.push(p);
    const t = hourly.temperature_2m?.[i];
    if (typeof t === "number") b.t.push(t);
    const h = hourly.relative_humidity_2m?.[i];
    if (typeof h === "number") b.h.push(h);
  }

  // Most negative 3-hour change beginning at each hour, bucketed by start day.
  const drop3h = new Map<string, number>();
  const P = hourly.surface_pressure;
  for (let i = 0; i + 3 < P.length; i++) {
    const a = P[i];
    const b = P[i + 3];
    if (typeof a !== "number" || typeof b !== "number") continue;
    const delta = b - a;
    const day = hourly.time[i].slice(0, 10);
    const cur = drop3h.get(day);
    if (cur === undefined || delta < cur) drop3h.set(day, delta);
  }

  const dailyIdx = new Map<string, number>();
  daily?.time.forEach((d, i) => dailyIdx.set(d, i));

  let prevMean = previousDayMeanPressure;
  const out: DayFactors[] = [];

  for (const day of order) {
    const b = byDay.get(day)!;
    const pMean = mean(b.p);
    const di = dailyIdx.get(day);
    const daylight =
      di !== undefined && typeof daily?.daylight_duration?.[di] === "number"
        ? (daily!.daylight_duration![di] as number) / 3600
        : null;

    out.push({
      local_date: day,
      pressure_mean_hpa: round(pMean),
      pressure_min_hpa: b.p.length ? round(Math.min(...b.p)) : null,
      pressure_max_hpa: b.p.length ? round(Math.max(...b.p)) : null,
      pressure_delta_24h:
        pMean !== null && prevMean !== null ? round(pMean - prevMean) : null,
      pressure_drop_max_3h: drop3h.has(day) ? round(drop3h.get(day)!) : null,
      temp_mean_c: round(mean(b.t)),
      temp_min_c:
        di !== undefined ? round(daily?.temperature_2m_min?.[di] ?? null) : null,
      temp_max_c:
        di !== undefined ? round(daily?.temperature_2m_max?.[di] ?? null) : null,
      humidity_mean: round(mean(b.h), 1),
      weather_code: di !== undefined ? (daily?.weather_code?.[di] ?? null) : null,
      daylight_hours: round(daylight, 2),
      dow: dayOfWeek(day),
    });

    if (pMean !== null) prevMean = pMean;
  }

  return out;
}

/** Inclusive list of YYYY-MM-DD between two dates. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

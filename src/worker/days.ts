// Day-level factor table: the control days for the trigger analysis.
//
// Weather is keyed on (local_date, location timeline), never on a device's
// geolocation. That fixes two production defects at once:
//   * a live capture recorded NULL pressure because location was never granted;
//   * enrichment ran at SYNC time, so an offline capture synced hours later
//     recorded the weather from whenever the POST happened to land.
//
// The same code path serves the historical backfill and the nightly refresh, so
// a day fetched two years late is identical to one fetched this morning.

import type { Bindings } from "./db";
import { nowIso } from "./db";
import { aggregateDays, dateRange, type DayFactors } from "../shared/weather";
import type { HealthDay } from "../shared/health";

export interface LocationRow {
  from_date: string;
  to_date: string;
  place: string;
  tz: string;
  lat: number;
  lon: number;
}

/** Days either side of a transition where weather may be attributed to the wrong place. */
const BOUNDARY_FLAG_DAYS = 2;

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";

export async function loadLocations(db: D1Database): Promise<LocationRow[]> {
  const res = await db
    .prepare(`SELECT from_date, to_date, place, tz, lat, lon FROM locations ORDER BY from_date`)
    .all<LocationRow>();
  return res.results;
}

export function locationFor(locs: LocationRow[], date: string): LocationRow | null {
  return locs.find((l) => date >= l.from_date && date <= l.to_date) ?? null;
}

const daysApart = (a: string, b: string) =>
  Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000));

/**
 * Dates where she actually moved country. Only the seam BETWEEN two adjacent
 * blocks is a transition: the first day she ever logged and the open-ended
 * far-future end date are edges of the timeline, not places she travelled.
 */
export function transitionDates(locs: LocationRow[]): string[] {
  const sorted = [...locs].sort((a, b) => a.from_date.localeCompare(b.from_date));
  return sorted.slice(1).flatMap((l, i) => [sorted[i].to_date, l.from_date]);
}

/** Near a move, a front may pass while she travels, so weather may be misattributed. */
export function nearBoundary(locs: LocationRow[], date: string): boolean {
  return transitionDates(locs).some((t) => daysApart(date, t) <= BOUNDARY_FLAG_DAYS);
}

/** Split an inclusive date range into contiguous blocks that share one location. */
export function blocksByLocation(
  locs: LocationRow[],
  from: string,
  to: string
): Array<{ loc: LocationRow; from: string; to: string }> {
  const blocks: Array<{ loc: LocationRow; from: string; to: string }> = [];
  for (const date of dateRange(from, to)) {
    const loc = locationFor(locs, date);
    if (!loc) continue; // no timeline coverage: skip rather than guess
    const last = blocks[blocks.length - 1];
    if (last && last.loc.place === loc.place && last.loc.tz === loc.tz) last.to = date;
    else blocks.push({ loc, from: date, to: date });
  }
  return blocks;
}

async function fetchArchiveBlock(
  loc: LocationRow,
  from: string,
  to: string
): Promise<DayFactors[]> {
  // Fetch one extra day before the block so pressure_delta_24h is defined on its
  // first day. Without it every block boundary would silently produce a null delta.
  const seedFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);

  const url =
    `${ARCHIVE}?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&start_date=${seedFrom}&end_date=${to}` +
    `&hourly=surface_pressure,temperature_2m,relative_humidity_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,daylight_duration` +
    `&timezone=${encodeURIComponent(loc.tz)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`archive ${res.status} for ${loc.place} ${from}..${to}`);
  const data = (await res.json()) as { hourly: never; daily?: never };

  const all = aggregateDays(data.hourly, data.daily);
  // Drop the seed day; it existed only to define the first delta.
  return all.filter((d) => d.local_date >= from);
}

export interface BackfillResult {
  from: string;
  to: string;
  blocks: number;
  days_written: number;
  skipped_no_location: number;
}

/**
 * Fetch and upsert every day in [from, to]. Idempotent: re-running overwrites the
 * same rows with the same values. Nothing about an episode is touched.
 */
export async function backfillDays(
  env: Bindings,
  from: string,
  to: string
): Promise<BackfillResult> {
  const locs = await loadLocations(env.DB);
  const blocks = blocksByLocation(locs, from, to);

  const covered = new Set(blocks.flatMap((b) => dateRange(b.from, b.to)));
  const skipped = dateRange(from, to).filter((d) => !covered.has(d)).length;

  let written = 0;
  const fetchedAt = nowIso();

  for (const b of blocks) {
    const rows = await fetchArchiveBlock(b.loc, b.from, b.to);
    // D1 caps how much a single batch can carry; chunk it.
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      await env.DB.batch(
        chunk.map((d) =>
          env.DB.prepare(
            `INSERT INTO days (
               local_date, place, tz, lat, lon,
               pressure_mean_hpa, pressure_min_hpa, pressure_max_hpa,
               pressure_delta_24h, pressure_drop_max_3h,
               temp_mean_c, temp_min_c, temp_max_c, humidity_mean,
               weather_code, daylight_hours, dow, near_location_boundary,
               source, fetched_at
             ) VALUES (?,?,?,?,?, ?,?,?, ?,?, ?,?,?,?, ?,?,?,?, 'open-meteo-archive', ?)
             ON CONFLICT(local_date) DO UPDATE SET
               place = excluded.place, tz = excluded.tz, lat = excluded.lat, lon = excluded.lon,
               pressure_mean_hpa = excluded.pressure_mean_hpa,
               pressure_min_hpa = excluded.pressure_min_hpa,
               pressure_max_hpa = excluded.pressure_max_hpa,
               pressure_delta_24h = excluded.pressure_delta_24h,
               pressure_drop_max_3h = excluded.pressure_drop_max_3h,
               temp_mean_c = excluded.temp_mean_c, temp_min_c = excluded.temp_min_c,
               temp_max_c = excluded.temp_max_c, humidity_mean = excluded.humidity_mean,
               weather_code = excluded.weather_code, daylight_hours = excluded.daylight_hours,
               dow = excluded.dow, near_location_boundary = excluded.near_location_boundary,
               fetched_at = excluded.fetched_at`
          ).bind(
            d.local_date, b.loc.place, b.loc.tz, b.loc.lat, b.loc.lon,
            d.pressure_mean_hpa, d.pressure_min_hpa, d.pressure_max_hpa,
            d.pressure_delta_24h, d.pressure_drop_max_3h,
            d.temp_mean_c, d.temp_min_c, d.temp_max_c, d.humidity_mean,
            d.weather_code, d.daylight_hours, d.dow,
            nearBoundary(locs, d.local_date) ? 1 : 0,
            fetchedAt
          )
        )
      );
      written += chunk.length;
    }
  }

  return { from, to, blocks: blocks.length, days_written: written, skipped_no_location: skipped };
}

// ── Health intake (F14) ──────────────────────────────────────────────────────

/**
 * Upsert on-device health factors onto `days`.
 *
 * Two invariants:
 *   * It NEVER touches the weather columns. A health push and a weather backfill
 *     write disjoint fields, so either can run at any time in any order.
 *   * Fields are COALESCEd, not overwritten. A push carrying only `sleep_minutes`
 *     must not wipe yesterday's `steps`; partial sources are the normal case.
 *
 * A day with no weather row is created here, so sleep can be recorded for a date
 * the backfill has not reached. The weather columns stay null and are simply
 * skipped by the factors that need them.
 */
export async function upsertHealthDays(
  env: Bindings,
  days: HealthDay[],
  source: string
): Promise<{ days_written: number }> {
  const at = nowIso();
  for (let i = 0; i < days.length; i += 50) {
    const chunk = days.slice(i, i + 50);
    await env.DB.batch(
      chunk.map((d) =>
        env.DB.prepare(
          `INSERT INTO days (local_date, fetched_at, sleep_minutes, sleep_efficiency,
                             steps, resting_hr, hrv_ms, health_source, health_fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(local_date) DO UPDATE SET
             sleep_minutes     = COALESCE(excluded.sleep_minutes, days.sleep_minutes),
             sleep_efficiency  = COALESCE(excluded.sleep_efficiency, days.sleep_efficiency),
             steps             = COALESCE(excluded.steps, days.steps),
             resting_hr        = COALESCE(excluded.resting_hr, days.resting_hr),
             hrv_ms            = COALESCE(excluded.hrv_ms, days.hrv_ms),
             health_source     = excluded.health_source,
             health_fetched_at = excluded.health_fetched_at`
        ).bind(
          d.local_date,
          at,
          d.sleep_minutes ?? null,
          d.sleep_efficiency ?? null,
          d.steps ?? null,
          d.resting_hr ?? null,
          d.hrv_ms ?? null,
          source,
          at
        )
      )
    );
  }
  return { days_written: days.length };
}

/** Nightly refresh: re-fetch the trailing window so recent days settle. */
export async function refreshRecentDays(env: Bindings, lookbackDays = 7): Promise<BackfillResult> {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  return backfillDays(env, from, to);
}

// Where the user was, when. Single source of truth for the importer.
//
// The same rows are seeded into the `locations` table by migration 0004, and a
// test asserts the two agree. The Worker reads the table; scripts read this.
//
// Barometric pressure is a synoptic-scale field, so one point per region is
// plenty: towns tens of kilometres apart differ by well under 1 hPa. The country
// is what matters, and that is what changes here.

export const TIMELINE = [
  { from: "2024-08-26", to: "2024-08-31", place: "Vienna, AT", tz: "Europe/Vienna", lat: 48.21, lon: 16.37 },
  { from: "2024-09-01", to: "2025-06-30", place: "London, UK",         tz: "Europe/London",     lat: 51.51, lon: -0.13 },
  { from: "2025-07-01", to: "2025-08-31", place: "Vienna, AT", tz: "Europe/Vienna", lat: 48.21, lon: 16.37 },
  { from: "2025-09-01", to: "2026-06-30", place: "London, UK",         tz: "Europe/London",     lat: 51.51, lon: -0.13 },
  { from: "2026-07-01", to: "2099-12-31", place: "Berlin, DE",          tz: "Europe/Berlin",   lat: 52.52, lon: 13.40 },
];

/** Days either side of a transition where weather may be attributed to the wrong place. */
export const BOUNDARY_FLAG_DAYS = 2;

export function daysBetween(a, b) {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000
  );
}

/**
 * Dates where she actually moved country. Only the seam BETWEEN two adjacent
 * blocks counts: the first day she ever logged, and the open-ended far-future end
 * date, are edges of the timeline rather than places she travelled.
 */
export function transitionDates() {
  return TIMELINE.slice(1).flatMap((r, i) => [TIMELINE[i].to, r.from]);
}

export function locationForDate(isoDate) {
  const hit = TIMELINE.find((r) => isoDate >= r.from && isoDate <= r.to);
  if (!hit) return null;
  const nearBoundary = transitionDates().some(
    (t) => Math.abs(daysBetween(isoDate, t)) <= BOUNDARY_FLAG_DAYS
  );
  return { ...hit, nearBoundary };
}

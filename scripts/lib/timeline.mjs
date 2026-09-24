// Where the user was, when. Single source of truth for the importer.
//
// The same rows are seeded into the `locations` table by migration 0004, and a
// test asserts the two agree. The Worker reads the table; scripts read this.
//
// The rows below are an EXAMPLE timeline. A real deployment replaces them (and the
// migration seed) with its own places, or edits the `locations` table directly.
//
// Barometric pressure is a synoptic-scale field, so one point per region is
// plenty: towns tens of kilometres apart differ by well under 1 hPa. The country
// is what matters, and that is what changes here.

export const TIMELINE = [
  { from: "2024-06-01", to: "2024-09-30", place: "Vienna, AT", tz: "Europe/Vienna", lat: 48.21, lon: 16.37 },
  { from: "2024-10-01", to: "2025-05-31", place: "London, UK", tz: "Europe/London", lat: 51.51, lon: -0.13 },
  { from: "2025-06-01", to: "2025-12-31", place: "Vienna, AT", tz: "Europe/Vienna", lat: 48.21, lon: 16.37 },
  { from: "2026-01-01", to: "2099-12-31", place: "Berlin, DE", tz: "Europe/Berlin", lat: 52.52, lon: 13.40 },
];

/** Days either side of a transition where weather may be attributed to the wrong place. */
export const BOUNDARY_FLAG_DAYS = 2;

export function daysBetween(a, b) {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000
  );
}

/**
 * Dates where the user actually moved country. Only the seam BETWEEN two adjacent
 * blocks counts: the first day ever logged, and the open-ended far-future end
 * date, are edges of the timeline rather than places travelled to.
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

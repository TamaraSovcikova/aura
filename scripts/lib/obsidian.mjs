// Pure helpers for importing the Obsidian migraine CSV.
// Kept dependency-free and side-effect free so they can be unit tested.
//
// Guiding rule (from the feature map): the old marking must not contaminate the
// new system. Nothing is inferred. Ambiguous data becomes "unknown", never a guess.

import { locationForDate, daysBetween } from "./timeline.mjs";

export { locationForDate, daysBetween };

/**
 * Parse a freeform onset string into { hour, minute } or null when ambiguous.
 *
 * Handles: "4:30pm", "9am", "12pm", "17:50pm" (24h with a stray suffix),
 * "8:30-9pm" (one meridiem in the string applies to the first token),
 * "6:30pm or 3:00am" (first token wins), "2pm, weak but steady" (prose tail).
 *
 * Refuses (returns null): "8:30", "6", "morning", "Night", "all night",
 * "-last night", and any sentence with no time token. These stay unknown rather
 * than being guessed at.
 */
export function parseOnset(raw) {
  if (!raw) return null;
  const s = String(raw);

  const tokens = [...s.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi)]
    .filter((m) => m[1] !== undefined && m[0].trim() !== "");
  if (tokens.length === 0) return null;

  const first = tokens[0];
  let hour = Number(first[1]);
  const minute = first[2] ? Number(first[2]) : 0;
  let meridiem = first[3] ? first[3].toLowerCase() : null;

  if (minute > 59) return null;

  // An hour past 12 is already 24-hour; a trailing "pm" on it is noise ("17:50pm").
  if (hour > 12) {
    if (hour > 23) return null;
    return { hour, minute };
  }

  // The token had no am/pm of its own. If the string carries exactly one distinct
  // meridiem, it governs ("8:30-9pm" -> 20:30). Otherwise we cannot know.
  if (!meridiem) {
    const found = [...new Set([...s.matchAll(/(am|pm)/gi)].map((m) => m[1].toLowerCase()))];
    if (found.length !== 1) return null;
    meridiem = found[0];
  }

  if (hour === 12) hour = meridiem === "am" ? 0 : 12;
  else if (meridiem === "pm") hour += 12;

  return { hour, minute };
}

/** Offset (ms) of a timezone at a given UTC instant. */
export function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(utcMs)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}

/** Convert a local wall-clock time in `tz` to a UTC ISO string. */
export function zonedToUtcIso(isoDate, hour, minute, tz) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let ts = guess - tzOffsetMs(guess, tz);
  const corrected = guess - tzOffsetMs(ts, tz);
  if (corrected !== ts) ts = corrected;
  return new Date(ts).toISOString();
}

/** Escape a value for a single-quoted SQL literal, or emit NULL. */
export function sqlLit(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/\0/g, "").replace(/'/g, "''")}'`;
}

const int = (v) => {
  const s = (v ?? "").toString().trim();
  return /^\d+$/.test(s) ? Number(s) : null;
};

/**
 * Map one CSV row to the shape we insert. Returns { episode, samples, warnings }.
 * `headache_type` and `triggers_canonical` are carried verbatim into the
 * quarantined self_reported_* fields and parsed into nothing.
 */
export function rowToEpisode(row) {
  const warnings = [];
  const localDate = (row.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return { episode: null, samples: [], warnings: [`bad date: ${JSON.stringify(row.date)}`] };
  }

  const loc = locationForDate(localDate);
  if (!loc) return { episode: null, samples: [], warnings: [`no location for ${localDate}`] };
  if (loc.nearBoundary) warnings.push(`${localDate}: near a location boundary, weather may be attributed to the wrong place`);

  const onsetRaw = (row.onset || "").trim() || null;
  const parsed = parseOnset(onsetRaw);
  if (onsetRaw && !parsed) warnings.push(`${localDate}: onset not parseable, time left unknown: ${JSON.stringify(onsetRaw)}`);

  // Unknown time anchors at local noon: safely inside the day for every offset,
  // so local_date can never drift across midnight.
  const hour = parsed ? parsed.hour : 12;
  const minute = parsed ? parsed.minute : 0;

  const severity = int(row.severity); // == level_peak in all rows where both exist
  if (severity !== null && (severity < 0 || severity > 10)) {
    return { episode: null, samples: [], warnings: [`${localDate}: severity out of range: ${severity}`] };
  }

  const startedAt = zonedToUtcIso(localDate, hour, minute, loc.tz);

  const episode = {
    local_date: localDate,
    started_at: startedAt,
    started_at_time_known: parsed ? 1 : 0,
    ended_at: null, // history has no end times
    tz: loc.tz,
    lat: loc.lat,
    lon: loc.lon,
    severity,
    note: (row.what_happened || "").trim() || null, // verbatim
    self_reported_triggers: (row.triggers_canonical || "").trim() || null, // quarantined
    self_reported_type: (row.headache_type || "").trim() || null, // quarantined
    onset_raw: onsetRaw,
    source: "obsidian-import",
    source_file: (row.source_file || "").trim() || null,
  };

  const samples = [];
  const levelStart = int(row.level_start);
  const levelPeak = int(row.level_peak);
  if (levelStart !== null) samples.push({ kind: "start", ts: startedAt, level: levelStart });
  if (levelPeak !== null) samples.push({ kind: "peak", ts: null, level: levelPeak }); // time unknown
  else if (severity !== null) samples.push({ kind: "peak", ts: null, level: severity });

  return { episode, samples, warnings };
}

/** Idempotent SQL for one mapped row. Safe to re-run: keyed on (source, source_file). */
export function episodeToSql({ episode, samples }) {
  const cols = [
    "local_date", "started_at", "started_at_time_known", "ended_at", "tz", "lat", "lon",
    "severity", "note", "self_reported_triggers", "self_reported_type", "onset_raw",
    "source", "source_file",
  ];
  const vals = cols.map((c) => sqlLit(episode[c])).join(", ");
  const key = `e.source = 'obsidian-import' AND e.source_file = ${sqlLit(episode.source_file)}`;

  const out = [
    `INSERT OR IGNORE INTO episodes (${cols.join(", ")}) VALUES (${vals});`,
  ];
  for (const s of samples) {
    out.push(
      `INSERT INTO severity_samples (episode_id, ts, level, kind)\n` +
      `  SELECT e.id, ${sqlLit(s.ts)}, ${s.level}, ${sqlLit(s.kind)} FROM episodes e\n` +
      `   WHERE ${key}\n` +
      `     AND NOT EXISTS (SELECT 1 FROM severity_samples v WHERE v.episode_id = e.id AND v.kind = ${sqlLit(s.kind)});`
    );
  }
  return out.join("\n");
}

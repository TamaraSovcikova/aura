-- 0004: the location timeline (F3) and the day-level factor table (F4).
--
-- This is the fix for two defects found in production:
--   * A live capture recorded NULL pressure because geolocation was never granted.
--   * Enrichment ran at SYNC time, not attack time, so an offline capture synced
--     hours later would have recorded the wrong weather.
--
-- Weather now comes from `days`, keyed on the local calendar day and the location
-- timeline. No device permission, correct for delayed syncs, and imported rows and
-- live rows are treated identically.
--
-- It is also what makes the trigger analysis possible at all: statistics need the
-- days WITHOUT a migraine, and those days are reconstructed here from an
-- objective archive rather than demanded from the user as daily logging.

CREATE TABLE locations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_date TEXT NOT NULL, -- inclusive YYYY-MM-DD
  to_date   TEXT NOT NULL, -- inclusive
  place     TEXT NOT NULL,
  tz        TEXT NOT NULL,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL
);

CREATE INDEX idx_locations_range ON locations (from_date, to_date);

-- Barometric pressure is a synoptic-scale field: towns tens of kilometres apart
-- differ by well under 1 hPa, so one point per region is enough. The country is
-- what matters, and that is what changes here.
-- These rows are an EXAMPLE timeline; a real deployment seeds its own places.
-- Must stay in sync with TIMELINE in scripts/lib/timeline.mjs (a test enforces it).
INSERT INTO locations (from_date, to_date, place, tz, lat, lon) VALUES
  ('2024-06-01', '2024-09-30', 'Vienna, AT', 'Europe/Vienna', 48.21, 16.37),
  ('2024-10-01', '2025-05-31', 'London, UK', 'Europe/London', 51.51, -0.13),
  ('2025-06-01', '2025-12-31', 'Vienna, AT', 'Europe/Vienna', 48.21, 16.37),
  ('2026-01-01', '2099-12-31', 'Berlin, DE', 'Europe/Berlin', 52.52, 13.40);

-- One row per calendar day, whether or not she had a headache. These are the
-- control days. `had_headache` is deliberately NOT stored: it is derived by
-- joining to episodes on local_date, so it can never go stale.
CREATE TABLE days (
  local_date            TEXT PRIMARY KEY, -- YYYY-MM-DD, local to `tz`
  place                 TEXT,
  tz                    TEXT,
  lat                   REAL,
  lon                   REAL,

  pressure_mean_hpa     REAL,
  pressure_min_hpa      REAL,
  pressure_max_hpa      REAL,
  -- Change in daily mean pressure against the previous day. The classic candidate.
  pressure_delta_24h    REAL,
  -- Most negative 3-hour pressure change starting within this day (falls can
  -- straddle midnight, so this is computed over the continuous hourly series).
  pressure_drop_max_3h  REAL,

  temp_mean_c           REAL,
  temp_min_c            REAL,
  temp_max_c            REAL,
  humidity_mean         REAL,
  weather_code          INTEGER,
  daylight_hours        REAL,
  dow                   INTEGER, -- 0 = Sunday .. 6 = Saturday

  -- Within a couple of days of a location change the weather may be attributed to
  -- the wrong place (a front can pass while she travels). Flagged, not dropped.
  near_location_boundary INTEGER NOT NULL DEFAULT 0,

  source                TEXT NOT NULL DEFAULT 'open-meteo-archive',
  fetched_at            TEXT NOT NULL
);

CREATE INDEX idx_days_pressure_delta ON days (pressure_delta_24h);
CREATE INDEX idx_days_drop3h ON days (pressure_drop_max_3h);

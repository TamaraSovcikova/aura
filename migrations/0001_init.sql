-- Aura Phase 0: one table for migraine episodes.
-- Capture is guaranteed; enrichment columns are nullable so a failed weather
-- lookup or missing geolocation never blocks a log.

CREATE TABLE episodes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT,                    -- nullable seam; NULL = single-user today
  started_at   TEXT NOT NULL,           -- ISO 8601 UTC
  ended_at     TEXT,                    -- NULL while an attack is ongoing
  severity     INTEGER,                 -- optional 1..3, tapped on end
  meds         TEXT,                    -- optional free text
  note         TEXT,                    -- optional (voice transcript or typed)
  weather_code INTEGER,                 -- Open-Meteo WMO code (enriched at start)
  pressure_hpa REAL,                    -- barometric pressure at start (hPa)
  temp_c       REAL,                    -- temperature at start (Celsius)
  lat          REAL,                    -- coarse, rounded ~2dp
  lon          REAL,
  tz           TEXT,                    -- IANA tz at capture
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_episodes_started ON episodes (started_at);
CREATE INDEX idx_episodes_open ON episodes (ended_at) WHERE ended_at IS NULL;

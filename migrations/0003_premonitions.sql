-- 0003: premonition events ("I feel one coming").
--
-- Deliberately NOT linked to an episode. Sometimes the feeling comes and no
-- headache follows, and those misses are the most valuable rows in the database:
-- comparing "felt it, got one" against "felt it, got nothing" controls for whatever
-- produces the feeling, which attack-days-vs-normal-days cannot do.
--
-- Lead time, hit rate and warning rate are all DERIVED at query time by pairing a
-- premonition with the next episode that starts within a window. Nothing is declared
-- by the user, so a false alarm is recorded simply by never being followed.

CREATE TABLE premonitions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT,                  -- nullable seam, matches episodes
  felt_at      TEXT NOT NULL,         -- ISO 8601 UTC
  local_date   TEXT,                  -- local calendar day, for day-based joins
  note         TEXT,                  -- optional; never required
  -- Best-effort context, same rules as episodes: a failure here never blocks the tap.
  weather_code INTEGER,
  pressure_hpa REAL,
  temp_c       REAL,
  lat          REAL,
  lon          REAL,
  tz           TEXT,
  source       TEXT NOT NULL DEFAULT 'app',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_prem_felt_at ON premonitions (felt_at);
CREATE INDEX idx_prem_local_date ON premonitions (local_date);

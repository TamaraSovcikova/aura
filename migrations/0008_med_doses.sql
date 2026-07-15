-- 0008: medication doses taken during an attack, with an optional relief follow-up.
--
-- The free-text episodes.meds field ("what I took") stays as-is for the doctor
-- export. This table adds the thing that field can never capture: WHEN a dose was
-- taken relative to onset, and whether (and how fast, and how far) it worked.
--
-- Two timestamps per dose make the whole payoff derivable without asking a single
-- extra question later:
--   time-to-relief = relief_at - taken_at   (how long before it took effect)
--   residual level = relief_severity         (what it pulled the pain down to, 0-10)
-- A dose with no relief_at is one that never brought relief (or is still pending),
-- which is itself the signal "this med did not work this time". Absence is not zero.
--
-- One episode has many doses (a second tablet an hour later is a second row), so
-- this is a child table, cascade-deleted with its episode.

CREATE TABLE med_doses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT,                    -- nullable seam, matches episodes
  episode_id      INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  name            TEXT,                    -- optional: which medication
  taken_at        TEXT NOT NULL,           -- ISO 8601 UTC, when the dose was taken
  relief_at       TEXT,                    -- ISO 8601 UTC, when "I feel better" tapped
  relief_severity INTEGER,                 -- 0..10 residual pain at relief (0 = gone)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_med_doses_episode ON med_doses (episode_id);

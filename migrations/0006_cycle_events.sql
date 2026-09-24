-- 0006: menstrual cycle events (F13).
--
-- One tap a month. From a handful of period-start dates, the cycle day of EVERY
-- calendar day in between is derivable, so the exposure exists for control days
-- too without any daily logging. Same shape as the weather: a sparse, objective
-- event stream from which a dense per-day factor is reconstructed.
--
-- `cycle_day` is deliberately NOT a column. It is derived at query time from these
-- events, so it can never go stale when a forgotten period is added later, and a
-- correction to one date silently fixes every day that depended on it.
--
-- Like premonitions, this cannot be backfilled: the imported diary carries no
-- cycle data. Every month not logged is
-- a month the hormonal hypothesis cannot be tested on.

CREATE TABLE cycle_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,                       -- nullable seam, matches episodes
  local_date TEXT NOT NULL UNIQUE,       -- the day the period STARTED
  kind       TEXT NOT NULL DEFAULT 'period_start'
             CHECK (kind IN ('period_start')),
  note       TEXT,
  source     TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cycle_events_date ON cycle_events (local_date);

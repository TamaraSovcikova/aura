-- 0005: on-device health factors (F14).
--
-- Health Connect has NO cloud API: it is an on-device store, and reads are
-- foreground-only. So nothing here can fetch the data itself. These columns are an
-- INTAKE: an Android reader (or a CSV export from any source that writes to Health
-- Connect) pushes daily aggregates in, and the trigger engine picks them up
-- automatically.
--
-- Why this matters more than any dashboard: the user's two strongest beliefs, "not
-- enough sleep" and "stress", were only ever recorded on days
-- she had a headache. With no control group they are permanently untestable. The
-- weather, which she cannot feel, IS testable and shows nothing. Recording sleep on
-- EVERY day, the way the weather already is, is the only thing that turns her
-- strongest belief into a hypothesis that can be checked.
--
-- These are attached to `days`, not to episodes, because a control day needs them
-- just as much as a headache day does. That is the whole point.

-- Sleep is attributed to the day she WOKE, not the day she fell asleep: the
-- exposure for a headache on day D is the night that ended on the morning of D.
ALTER TABLE days ADD COLUMN sleep_minutes INTEGER;
ALTER TABLE days ADD COLUMN sleep_efficiency REAL;    -- 0..1, asleep / in-bed
ALTER TABLE days ADD COLUMN steps INTEGER;
ALTER TABLE days ADD COLUMN resting_hr INTEGER;       -- bpm
ALTER TABLE days ADD COLUMN hrv_ms REAL;              -- heart-rate variability

-- Provenance, kept separate from the weather's `source`/`fetched_at` so a health
-- push can never look like it re-fetched the weather.
ALTER TABLE days ADD COLUMN health_source TEXT;       -- 'health-connect' | 'csv-import' | ...
ALTER TABLE days ADD COLUMN health_fetched_at TEXT;

CREATE INDEX idx_days_sleep ON days (sleep_minutes);

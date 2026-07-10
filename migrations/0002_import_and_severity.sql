-- 0002: 0-10 severity scale, severity samples, import provenance, ICHD-3 attributes.
--
-- Phase 0 stored severity as 1-3 (Mild/Moderate/Severe). The real history and the
-- clinical VAS standard both use 0-10, so the scale changes here and existing rows
-- are remapped (1->3, 2->6, 3->9). At migration time every existing row was written
-- on the old scale, so the remap is complete and unambiguous.

-- ── Provenance + quarantined self-reported fields ───────────────────────────
-- self_reported_* are imported verbatim from Obsidian and NEVER feed the trigger
-- engine or any classification. Their only use is the belief-vs-data comparison.
ALTER TABLE episodes ADD COLUMN source TEXT NOT NULL DEFAULT 'app'; -- 'app' | 'obsidian-import'
ALTER TABLE episodes ADD COLUMN source_file TEXT;
ALTER TABLE episodes ADD COLUMN self_reported_triggers TEXT;
ALTER TABLE episodes ADD COLUMN self_reported_type TEXT;
ALTER TABLE episodes ADD COLUMN onset_raw TEXT;

-- The calendar day the attack belongs to, in the local timezone. All day-based
-- metrics (monthly headache days) group by this, never by the UTC timestamp,
-- so a 23:00 BST attack cannot silently land on the previous day.
ALTER TABLE episodes ADD COLUMN local_date TEXT;

-- 0 when started_at carries a placeholder time (ambiguous or missing onset).
-- Time-of-day analytics must exclude these rows.
ALTER TABLE episodes ADD COLUMN started_at_time_known INTEGER NOT NULL DEFAULT 1;

-- ── ICHD-3 attributes ──────────────────────────────────────────────────────
-- All nullable. NULL means "not captured", never "no". Nothing is ever inferred
-- from free text or from the old headache_type field.
ALTER TABLE episodes ADD COLUMN side TEXT;                      -- 'one' | 'both'
ALTER TABLE episodes ADD COLUMN quality TEXT;                   -- 'throbbing' | 'pressing'
ALTER TABLE episodes ADD COLUMN aggravated_by_activity INTEGER; -- 0 | 1
ALTER TABLE episodes ADD COLUMN nausea INTEGER;                 -- 0 | 1
ALTER TABLE episodes ADD COLUMN photophobia INTEGER;            -- 0 | 1
ALTER TABLE episodes ADD COLUMN phonophobia INTEGER;            -- 0 | 1
ALTER TABLE episodes ADD COLUMN aura INTEGER;                   -- 0 | 1

-- ── Severity samples ───────────────────────────────────────────────────────
-- Peak-per-attack and peak-per-day are derived from these, which is what makes
-- multi-day attacks work: each calendar day gets its own peak.
-- ts is NULL when the sample's time is unknown (an imported level_peak).
CREATE TABLE severity_samples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  ts         TEXT,
  level      INTEGER NOT NULL CHECK (level BETWEEN 0 AND 10),
  kind       TEXT NOT NULL DEFAULT 'sample' CHECK (kind IN ('start', 'peak', 'sample')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sev_episode ON severity_samples (episode_id);

-- Idempotent re-import: one row per source note.
CREATE UNIQUE INDEX idx_episodes_source_file
  ON episodes (source, source_file) WHERE source_file IS NOT NULL;

CREATE INDEX idx_episodes_local_date ON episodes (local_date);

-- ── Backfill existing rows ─────────────────────────────────────────────────
-- Every pre-existing row used the 1-3 scale. Values >3 cannot exist yet.
UPDATE episodes
   SET severity = CASE severity WHEN 1 THEN 3 WHEN 2 THEN 6 WHEN 3 THEN 9 END
 WHERE severity BETWEEN 1 AND 3;

-- Approximate local_date for pre-existing rows from the UTC date. Acceptable:
-- production held no episodes at migration time.
UPDATE episodes SET local_date = substr(started_at, 1, 10) WHERE local_date IS NULL;

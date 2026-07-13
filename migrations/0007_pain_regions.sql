-- 0007: where it hurts (F19, the head map).
--
-- The ICHD-3 attribute columns (side, quality, nausea, photophobia, phonophobia,
-- aura, aggravated_by_activity) already exist from migration 0002. The only thing
-- the head map adds is the painted regions themselves, stored as a JSON array of
-- region ids (e.g. ["l-temple","l-eye"]). `side` is DERIVED from these at capture
-- time and written to the existing column, so the classifier never has to parse
-- this text: it is kept for display, so the map can be shown again as she painted it.
--
-- Nullable, no default: an attack with no head map recorded is unknown, not empty.

ALTER TABLE episodes ADD COLUMN pain_regions TEXT;

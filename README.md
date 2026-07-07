# Aura

Phone-first migraine tracker that wins by collecting less. One tap starts an
episode, a second tap ends it (duration logs itself), and context you would never
backfill (time, weather, barometric pressure, day of week) is attached
automatically. A voice note captures the one human detail. Clean pattern charts and
a doctor-ready export come out as a byproduct.

Replaces an Obsidian logging habit whose real failure was capture friction, not
analysis.

## Status

Phase 0 built and verified locally 2026-07-07 (capture UI + episodes API + D1 +
offline outbox + PWA; 16 tests passing). Not deployed to production yet. See
`docs/SPEC-phase0.md` and CLAUDE.md for how to run.

## Stack (planned)

- Installable PWA (front end), TypeScript
- Cloudflare Worker + D1 (SQLite) backend
- Weather API (barometric pressure) for auto-enrichment; Web Speech API for voice

## Build order

- **Phase 0:** capture-only PWA (one-tap start/stop, auto-enriched context). Live on it.
- **Phase 1:** dashboards (frequency, worsening trend, duration, triggers) + one-tap
  doctor export, built on real data.
- **Phase 2 (native):** true one-tap widget / Quick Settings tile, Google Health
  (Health Connect) sleep, early-warning experiments.

## Docs

Full narrative + design lives in the Workspace vault at
`docs/` (PURPOSE, ARCHITECTURE, EVOLUTION, INTERVIEW,
MISTAKES, DESIGN-capture-first-mvp). Operational notes for this repo are in
`CLAUDE.md`.

Personal project under the `TamaraSovcikova` GitHub account.

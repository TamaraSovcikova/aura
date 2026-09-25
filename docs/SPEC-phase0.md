# Phase 0: capture-only migraine PWA (one-tap logging + auto-enrichment)

## Context

Aura replaces a failing Obsidian migraine-logging habit whose real problem is
capture friction: logging needs a computer, so entries are backfilled late and
half-empty. Phase 0 proves the fix with the smallest thing that matters: one-tap
start/stop capture on the phone, with context auto-attached so entries are complete
without typing. No dashboards yet. Dashboards and doctor export come in Phase 1,
built on the real data Phase 0 collects.

## Current state

Greenfield. The repo contains only
the skeleton: `README.md`, `CLAUDE.md`, `.gitignore`. No app code.

## Proposed change

A one-screen installable PWA, backed by a
Cloudflare Worker + D1. Capture is guaranteed; enrichment is best-effort.

### Stack (decisions locked)

- **Front end (D1):** Vite + React 19 + TypeScript, Tailwind v4, `vite-plugin-pwa`.
  Deliberately light (no dnd-kit, radix, tanstack-query, router). One screen in Phase 0, grows into Phase 1 dashboards.
- **Backend:** Hono on a Cloudflare Worker.
- **Database:** Cloudflare D1 (SQLite), `wrangler d1 migrations`.
- **Weather:** Open-Meteo (`https://api.open-meteo.com/v1/forecast`), free, no API key,
  returns `surface_pressure` (hPa), `temperature_2m`, `weather_code`.
- **Access guard (D2):** shared PIN via Worker secret `ACCESS_PIN`; client sends
  `Authorization: Bearer <PIN>`, entered once and saved on device. Health data is not
  world-writable.
- **Offline (D3):** minimal outbox. If offline, capture the timestamp locally
  (IndexedDB/localStorage) and sync the row when back online; enrichment backfills at
  sync time. Capture must never fail for lack of signal.

### Data model (migration `0001_init.sql`)

```sql
CREATE TABLE episodes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT,                    -- nullable seam; NULL = single-user today
  started_at   TEXT NOT NULL,           -- ISO 8601 UTC
  ended_at     TEXT,                    -- NULL while an attack is ongoing
  severity     INTEGER,                 -- optional 1..3, tapped on end
  meds         TEXT,                    -- optional free text
  note         TEXT,                    -- optional (voice transcript or typed)
  weather_code INTEGER,                 -- Open-Meteo WMO code (enriched at start)
  pressure_hpa REAL,                    -- barometric pressure at start
  temp_c       REAL,
  lat          REAL,
  lon          REAL,                    -- coarse, rounded ~2dp
  tz           TEXT,                    -- IANA tz at capture
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_episodes_started ON episodes(started_at);
CREATE INDEX idx_episodes_open ON episodes(ended_at) WHERE ended_at IS NULL;
```

`day_of_week` is derived from `started_at`, not stored. `pressure_hpa`, `temp_c`,
`weather_code`, `lat`, `lon` are nullable so enrichment failure never blocks a log.

### API (Hono)

All routes require `Authorization: Bearer <ACCESS_PIN>`; missing/wrong = 401.

| Method | Route | Body | Purpose |
|---|---|---|---|
| POST | `/api/episodes/start` | `{lat?, lon?, tz, client_started_at?}` | Create open episode. Server sets `started_at` (or trusts `client_started_at` for offline-synced rows), enriches weather from Open-Meteo best-effort. Returns the row. |
| POST | `/api/episodes/:id/end` | `{severity?, meds?, note?, client_ended_at?}` | Set `ended_at`, optional fields. Returns the row. |
| GET | `/api/episodes/current` | (none) | The open episode (`ended_at IS NULL`) or `null`. |
| GET | `/api/episodes?limit=30` | (none) | Recent episodes, newest first. |
| PATCH | `/api/episodes/:id` | partial fields | Fix a mistake. |

Enrichment: on start with `lat`/`lon`, call Open-Meteo
`?latitude=..&longitude=..&current=temperature_2m,surface_pressure,weather_code`.
On any failure or missing geo, store nulls and return 200. Never 5xx a capture.

### Capture flow (client)

- One screen. Big primary button.
  - No open episode → "Migraine started". On tap: request geolocation (if permitted),
    POST `/start`, flip button to "Migraine ended" with a live elapsed timer.
  - Open episode → "Migraine ended". On tap: POST `/end`, then show an optional,
    dismissible quick-panel: severity 1-3 tap, voice note (Web Speech API →
    `note`), meds text. All optional.
- On load, GET `/current` decides which button state to show (survives reload).
- Offline: writes go to the outbox and reconcile on reconnect; UI shows a subtle
  "queued" state. Duration integrity comes from the captured timestamps.
- Installable: manifest + icons + service worker via `vite-plugin-pwa`.

## Acceptance criteria

1. PWA installs to an Android home screen (manifest valid, service worker registers).
2. One tap opens an episode with a server timestamp; a second tap closes it; stored
   duration equals end minus start.
3. An open episode survives an app reload (UI reads `/current` and shows "ended" state).
4. With geolocation allowed, `pressure_hpa`, `temp_c`, `weather_code` are populated;
   with geolocation denied or Open-Meteo down, the episode still saves (nulls), no error.
5. A capture performed offline appears in the outbox and syncs on reconnect exactly
   once (no dupes), preserving the original timestamp.
6. Voice note transcribes speech into `note` on a supporting browser; absence of the
   API degrades gracefully to the text field.
7. All routes reject requests without a valid `Authorization: Bearer <PIN>` (401).
8. Tests written and passing; no regressions.

## Testing plan

| Layer | What | Count |
|---|---|---|
| Unit | duration calc, Open-Meteo enrich mapper, outbox dedupe/reconcile, PIN guard | +5 |
| Integration | start → current → end round-trip on D1; enrichment-failure path returns 200 with nulls; 401 on missing PIN | +3 |
| E2E (manual, phone) | install to home screen, tap start/stop, offline capture then reconnect, voice note | checklist |

## Rollback plan

Pre-production; nothing to roll back to. Revert the feature branch / PR. D1 is
disposable in Phase 0 (a single user). Migrations are additive; a bad
migration is dropped by recreating the local/remote D1.

## Effort estimate

~1 day of focused work: 1h scaffold (vite + wrangler + PWA + Tailwind) + 1h D1 schema
+ migration + 3h Worker API (routes, PIN guard, Open-Meteo enrich) + 3h client (one
screen, timer, quick-panel, voice) + 2h offline outbox + 2h tests + deploy.

## Files reference (to be created)

| File | Change |
|---|---|
| `package.json`, `vite.config.ts`, `wrangler.jsonc`, `tsconfig.json` | Scaffold |
| `migrations/0001_init.sql` | `episodes` table + indexes |
| `src/worker/index.ts` | Hono app, routes, PIN guard |
| `src/worker/enrich.ts` | Open-Meteo fetch + map to columns (best-effort) |
| `src/client/App.tsx` | One-screen capture UI + timer + quick-panel |
| `src/client/outbox.ts` | Offline queue + reconcile |
| `src/client/voice.ts` | Web Speech API wrapper |
| `public/manifest.webmanifest`, icons | PWA install |
| `test/*` | Unit + integration (Vitest) |

## Out of scope (Phase 0)

- Dashboards / charts, "is it getting worse" trend.
- Doctor export (PDF/CSV), Obsidian export.
- Google Health / Health Connect sleep + steps.
- Native widget / Quick Settings tile (true one-tap).
- Multi-user / accounts (schema seam `user_id` only).


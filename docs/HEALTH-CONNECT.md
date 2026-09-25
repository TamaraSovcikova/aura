# F14: getting sleep, steps and HRV into Aura

## Why this matters more than any dashboard

The two most common self-reported migraine triggers are **"not enough sleep"** and
**"stress"**. In the imported diary both were recorded *only on headache days*. With no control group they are permanently untestable, no matter how
much history accumulates.

Meanwhile the weather, which nobody can feel and nobody logged, **is** testable,
because `days` holds it for every calendar day. The trigger engine tests seven
weather factors against headache and non-headache days.

Recording sleep on *every* day, the way the weather already is, is the only thing
that turns the sleep belief into a hypothesis that can be checked.

## The constraint (verified, 2026-07)

- **Health Connect has no cloud API.** It is an on-device, encrypted store. There
  is no way to query it from a server. An Android app must read it and upload.
- **Reads are foreground-only** by default. Background reads need a separate,
  explicitly declared permission.
- **A phone alone does not produce sleep data.** Bedtime mode is a schedule,
  not sleep sensing. Something must *write* sleep sessions into Health Connect.

So F14 splits in two: the server intake (built, tested, and shipped) and the
on-device reader (needs a device; not buildable in this repo's toolchain).

## What is already built

| Piece | Status |
|---|---|
| `days.sleep_minutes`, `sleep_efficiency`, `steps`, `resting_hr`, `hrv_ms` | migration `0005` |
| `POST /api/days/health`: idempotent, merges partial pushes, **never touches the weather columns** | done |
| `GET /api/days/health/coverage` | done |
| Sleep/steps/HR/HRV added to the trigger engine's factor set | done |
| `scripts/import-health.mjs`: push any CSV, dry-run by default | done |
| `get_overview` (MCP) reports `control_days.days_with_sleep` | done |

Empty health columns report `insufficient data` and are **excluded from the
multiple-comparison correction**, so they cannot weaken the weather results merely
by existing. There is a test for exactly that.

## Which day a night's sleep belongs to

**Sleep belongs to the day the sleeper WOKE, not the day they fell asleep.**

The exposure for a headache on day D is the night that *ended* on the morning of D.
Keying it to the day of falling asleep would shift every value one day out of phase
with the outcome. Nothing would visibly break; the results would just be wrong.

`POST /api/days/health` with `sleep_sessions` does this for you (it needs `tz`).
If you push pre-aggregated `days`, you must have done it yourself.

## Step 0: pick a sleep source

Nothing downstream works until something writes sleep sessions into Health Connect:

- **A Pixel Watch or other wearable.** Most accurate, needs hardware.
- **Sleep as Android** on the phone. Uses the accelerometer, microphone and light
  sensor; writes to Health Connect. No extra hardware.
- **Any other app** that writes `SleepSessionRecord`.

## Then pick an upload path

**A. CSV export (works today, zero native code).**
Export from whatever app records sleep, then:

```bash
node scripts/import-health.mjs --csv sleep.csv                 # dry run, sends nothing
node scripts/import-health.mjs --csv sleep.csv --apply --pin $AURA_PIN   # with AURA_URL set
```

Accepted columns (any subset): `date`/`local_date`, `sleep_minutes` or
`sleep_hours`, `sleep_efficiency`, `steps`, `resting_hr`, `hrv_ms`.

**B. A small Android reader (the eventual right answer).**
A single-screen app that reads Health Connect on open and POSTs. Sketch:

```kotlin
val client = HealthConnectClient.getOrCreate(context)
val sessions = client.readRecords(
    ReadRecordsRequest(
        SleepSessionRecord::class,
        timeRangeFilter = TimeRangeFilter.between(since, Instant.now())
    )
).records

val body = buildJsonObject {
    put("source", "health-connect")
    put("tz", ZoneId.systemDefault().id)
    putJsonArray("sleep_sessions") {
        sessions.forEach { s ->
            addJsonObject {
                put("start", s.startTime.toString())
                put("end", s.endTime.toString())   // the server keys on the WAKE day
            }
        }
    }
}
// POST to https://<your-worker>.workers.dev/api/days/health
// header: Authorization: Bearer <ACCESS_PIN>
```

Permissions: `android.permission.health.READ_SLEEP` (plus `READ_STEPS`,
`READ_RESTING_HEART_RATE`, `READ_HEART_RATE_VARIABILITY` as wanted). Reads are
foreground-only unless you also declare background read.

**This code is unverified.** It cannot be built or run in this repo: there is no
Android SDK and no device here. Treat it as a specification, not a tested artifact.

## When will sleep actually be testable?

The trigger engine's gates are: at least 30 headache days with data, 30 control
days with data, and 6 `(place, month)` strata.

| Gate | Time to satisfy (at ~9 headache days/month) |
|---|---|
| 30 control days with sleep | ~1.4 months |
| 30 headache days with sleep | ~3.2 months |
| **6 strata** | **~6 months** ← binding constraint |

So: **roughly six months of continuous nightly data** before `sleep_minutes` can
return anything other than `insufficient data`.

Like the premonition button, none of this can be backfilled. Every night that goes
unrecorded is gone, which is why recording should start before the dashboard is
finished.

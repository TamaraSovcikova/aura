# Aura

A migraine tracker for the phone. You tap once when an attack starts and once when it ends; the app records the time and the day's weather and barometric pressure by itself. Symptoms, medication and notes are asked for afterwards and are all optional. The collected data feeds a set of statistics, including a test of whether weather, the menstrual cycle or medication relate to headache days.

<table>
  <tr>
    <td><img src="docs/screenshots/today.png" width="220" alt="Today screen with the button to start an attack"></td>
    <td><img src="docs/screenshots/walkthrough.png" width="220" alt="End-of-attack questions, on the head map page"></td>
    <td><img src="docs/screenshots/history.png" width="220" alt="History as a month calendar shaded by severity"></td>
    <td><img src="docs/screenshots/attack-detail.png" width="220" alt="One attack with its timeline of doses and relief"></td>
  </tr>
  <tr>
    <td align="center"><sub>Start an attack</sub></td>
    <td align="center"><sub>Questions after an attack</sub></td>
    <td align="center"><sub>History by month</sub></td>
    <td align="center"><sub>One attack</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/insights.png" width="220" alt="Headache and migraine days per month"></td>
    <td><img src="docs/screenshots/insights-head.png" width="220" alt="Where it hurts, and when attacks start"></td>
    <td><img src="docs/screenshots/insights-weather.png" width="220" alt="Weather factors compared between headache days and other days"></td>
    <td></td>
  </tr>
  <tr>
    <td align="center"><sub>Monthly counts</sub></td>
    <td align="center"><sub>Where and when</sub></td>
    <td align="center"><sub>Weather</sub></td>
    <td></td>
  </tr>
</table>

<sub>The screenshots use made-up data.</sub>

## Why I built it

I kept a migraine diary in a notes app, and most entries were written hours later and left half empty, because writing them needed a computer. Aura makes the capture step as short as possible:

- Starting and ending an attack is one tap each. The duration is calculated from the two taps.
- Weather and pressure are fetched for every calendar day from a location timeline, so the phone's location is never needed.
- After an attack, a short series of pages asks how bad it was, where it hurt, what came with it and what was taken. Every page can be skipped, and "not sure" is saved as unknown.
- Attacks logged without signal are stored on the phone and sent once the connection is back.

## How the statistics work

- **Headache days and migraine days.** Attacks with recorded symptoms are checked against the [ICHD-3](https://ichd-3.org/) migraine criteria. Attacks without symptoms count as headache days only. The app reports which criteria are met and does not diagnose.
- **Weather.** Weather is stored for every day, including days without a headache, so each factor is compared between headache days and the other days. The comparison is stratified by place and month, so season and location do not show up as triggers, and the results are corrected for testing several factors at once (Benjamini-Hochberg).
- **Self-reported triggers.** Trigger tags imported from the old diary were only written on headache days, so there is nothing to compare them against. They are kept as notes and not used as evidence.
- **Trends.** Months that were only partly recorded are left out of averages.
- **Minimum data.** Each statistic checks whether it has enough data and reports that it does not, instead of giving a result.
- **Medication.** Relief rate, time to relief, and the ICHD-3 medication-overuse day counts.
- **Cycle.** A Mantel-Haenszel odds ratio for headaches in the days around a period start. Days whose cycle day is unknown are excluded.

## Connecting Claude

Aura has an [MCP](https://modelcontextprotocol.io) server at `/mcp`. The app calculates the statistics and Claude reads them through the server's tools. The tool descriptions state what the numbers mean, for example that headache days are not migraine days and that self-reported triggers are not evidence, because the model works from those descriptions.

## Stack

- **Client:** TypeScript, React 19, Vite, Tailwind v4. Installable as a PWA and usable offline, with dictation through the Web Speech API and an SVG head map.
- **Server:** Hono on a Cloudflare Worker, with a nightly job that fetches daily weather from Open-Meteo.
- **Database:** Cloudflare D1 (SQLite).
- **Tests:** over 330 Vitest tests, including integration tests that apply the real migrations to a local SQLite database.

## Running it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # sets a local ACCESS_PIN
npm run migrate:local
npm run build && npm run dev:worker   # http://localhost:8787
npm test
```

To deploy you need a Cloudflare account: create a D1 database, put its id in `wrangler.jsonc`, run `npm run migrate:remote`, set the PIN with `wrangler secret put ACCESS_PIN`, then run `npm run deploy`.

## Licence

[MIT](LICENSE)

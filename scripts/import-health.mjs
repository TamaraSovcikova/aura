#!/usr/bin/env node
// Push daily health factors into Aura from a CSV.
//
// Health Connect has no cloud API, so something on the phone has to hand the data
// over. This script is the source-agnostic path: any exporter that can produce a
// CSV works (Health Connect's own export, Sleep as Android, Google Health/Takeout,
// a watch app, a spreadsheet you typed by hand).
//
//   node scripts/import-health.mjs --csv sleep.csv                 # dry run
//   AURA_URL=https://... node scripts/import-health.mjs --csv sleep.csv --apply   # push
//
// Expected columns (any subset, extra columns ignored):
//   date | local_date   YYYY-MM-DD, the day the sleeper WOKE
//   sleep_minutes  (or sleep_hours)
//   sleep_efficiency (0..1, or 0..100 with --efficiency-percent)
//   steps
//   resting_hr
//   hrv_ms
//
// Dry run writes nothing and contacts nothing.

import { readFileSync } from "node:fs";

const UA = "aura-health-import/1.0";
const DEFAULT_URL = process.env.AURA_URL ?? "http://localhost:8787";

function parseArgs(argv) {
  const a = { csv: null, apply: false, url: DEFAULT_URL, pin: process.env.AURA_PIN, effPct: false, source: "csv-import" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--csv") a.csv = argv[++i];
    else if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--url") a.url = argv[++i];
    else if (argv[i] === "--pin") a.pin = argv[++i];
    else if (argv[i] === "--source") a.source = argv[++i];
    else if (argv[i] === "--efficiency-percent") a.effPct = true;
  }
  return a;
}

/** RFC4180-ish parser: quoted fields, embedded commas and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  return rows
    .filter((r) => r.some((v) => v.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const num = (v) => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function rowToHealthDay(row, opts = {}) {
  const date = row.local_date || row.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const out = { local_date: date };
  const mins = num(row.sleep_minutes);
  const hours = num(row.sleep_hours);
  if (mins !== undefined) out.sleep_minutes = Math.round(mins);
  else if (hours !== undefined) out.sleep_minutes = Math.round(hours * 60);

  let eff = num(row.sleep_efficiency);
  if (eff !== undefined) {
    if (opts.effPct) eff = eff / 100;
    out.sleep_efficiency = eff;
  }
  const steps = num(row.steps);
  if (steps !== undefined) out.steps = Math.round(steps);
  const hr = num(row.resting_hr ?? row.resting_heart_rate);
  if (hr !== undefined) out.resting_hr = Math.round(hr);
  const hrv = num(row.hrv_ms ?? row.hrv);
  if (hrv !== undefined) out.hrv_ms = hrv;

  // Nothing but a date is not worth sending.
  return Object.keys(out).length > 1 ? out : null;
}

const args = parseArgs(process.argv);
if (!args.csv) {
  console.error("usage: node scripts/import-health.mjs --csv <file> [--apply] [--pin <pin>]");
  process.exit(1);
}

const rows = parseCsv(readFileSync(args.csv, "utf8"));
const days = [];
let skipped = 0;
for (const r of rows) {
  const d = rowToHealthDay(r, { effPct: args.effPct });
  if (d) days.push(d);
  else skipped++;
}

const counts = (k) => days.filter((d) => d[k] !== undefined).length;
console.log("=== Aura health import: DRY RUN ===\n");
console.log(`CSV rows read     : ${rows.length}`);
console.log(`Days to push      : ${days.length}`);
console.log(`Skipped (no date / no values): ${skipped}`);
console.log(`  sleep_minutes   : ${counts("sleep_minutes")}`);
console.log(`  sleep_efficiency: ${counts("sleep_efficiency")}`);
console.log(`  steps           : ${counts("steps")}`);
console.log(`  resting_hr      : ${counts("resting_hr")}`);
console.log(`  hrv_ms          : ${counts("hrv_ms")}`);
if (days.length) {
  console.log(`Date range        : ${days[0].local_date} .. ${days[days.length - 1].local_date}`);
  console.log(`\nSample: ${JSON.stringify(days[0])}`);
}

console.log(
  `\nReminder: sleep_minutes must be keyed on the day the sleeper WOKE, not the day they fell asleep.`
);

if (!args.apply) {
  console.log(`\nNo --apply, so nothing was sent.`);
  process.exit(0);
}
if (!args.pin) {
  console.error(`\n--apply needs the PIN: pass --pin or set AURA_PIN.`);
  process.exit(1);
}

let written = 0;
for (let i = 0; i < days.length; i += 100) {
  const chunk = days.slice(i, i + 100);
  const res = await fetch(`${args.url}/api/days/health`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.pin}`,
      "Content-Type": "application/json",
      "User-Agent": UA, // Cloudflare bot protection rejects default script agents
    },
    body: JSON.stringify({ source: args.source, days: chunk }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`  chunk ${i}: FAILED ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    continue;
  }
  written += body.days_written;
  if (body.rejected?.length) {
    console.log(`  chunk ${i}: ${body.days_written} written, ${body.rejected.length} rejected`);
    for (const r of body.rejected.slice(0, 3)) console.log(`    ! ${r.local_date}: ${r.reason}`);
  }
}
console.log(`\nPushed ${written} days.`);

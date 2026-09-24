#!/usr/bin/env node
// Pull the Aura snapshot and write it into the Obsidian vault (F16).
//
// The app is the source of truth; this keeps the vault's Dataview dashboards alive
// by refreshing a single read-only markdown file. Re-run it whenever you want the
// dashboard current. It writes exactly one file and contacts only the Aura API.
//
//   node scripts/export-obsidian.mjs                 # print to stdout (dry run)
//   node scripts/export-obsidian.mjs --out PATH      # write the file
//   AURA_URL=https://... AURA_PIN=... node scripts/export-obsidian.mjs --out "~/notes/Aura-snapshot.md" --write
//
// Health data never enters the repo: --out points into the vault, and the default
// dry run writes nothing.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

const DEFAULT_URL = process.env.AURA_URL ?? "http://localhost:8787";

function parseArgs(argv) {
  const a = { url: DEFAULT_URL, pin: process.env.AURA_PIN, out: null, write: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--url") a.url = argv[++i];
    else if (argv[i] === "--pin") a.pin = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--write") a.write = true;
    else if (argv[i] === "--help" || argv[i] === "-h") a.help = true;
  }
  return a;
}

const expand = (p) => (p.startsWith("~") ? p.replace(/^~/, homedir()) : p);

async function main() {
  const a = parseArgs(process.argv);
  if (a.help) {
    console.log("Usage: export-obsidian.mjs [--out PATH] [--write] [--url URL] [--pin PIN]");
    return;
  }
  if (!a.pin) {
    console.error("No PIN. Set AURA_PIN or pass --pin. (It is the app access PIN.)");
    process.exit(1);
  }

  const res = await fetch(`${a.url}/api/export/obsidian`, {
    headers: { Authorization: `Bearer ${a.pin}`, "User-Agent": "aura-obsidian-export/1.0" },
  });
  if (res.status === 401) {
    console.error("401: the PIN was rejected.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Export failed: ${res.status}`);
    process.exit(1);
  }
  const md = await res.text();

  if (!a.out || !a.write) {
    // Dry run: show what would be written, and how much.
    const lines = md.split("\n").length;
    process.stderr.write(
      a.out
        ? `Dry run. ${lines} lines ready for ${a.out}. Pass --write to save.\n`
        : `Dry run (${lines} lines). Pass --out PATH --write to save into your vault.\n\n`
    );
    if (!a.out) process.stdout.write(md);
    return;
  }

  const path = expand(a.out);
  writeFileSync(path, md, "utf8");
  console.log(`Wrote ${md.split("\n").length} lines to ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

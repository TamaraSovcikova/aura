// F7: the doctor export.
//
// Two formats, both honest about provenance:
//   * CSV  — every episode, with the derived duration and the day's factors.
//   * HTML — a print-ready summary. A neurologist works in monthly headache days,
//            so that is what leads. Print to PDF from the browser; generating a PDF
//            inside a Worker would mean shipping a rendering engine to say the same
//            thing worse.
//
// Nothing is claimed that the data cannot support. The header states plainly that
// these are headache days, that imported rows have no duration, and that Aura does
// not diagnose.

import { buildSummary } from "./insights";
import { cycleContext } from "../shared/cycle";
import { loadPeriodStarts } from "./cycle";
import { classifyAttack, type AttackAttributes, type Ichd3Verdict } from "../shared/ichd3";

const esc = (s: unknown): string => {
  const v = s === null || s === undefined ? "" : String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

const html = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function episodesCsv(db: D1Database): Promise<string> {
  const starts = await loadPeriodStarts(db);
  const rows = await db
    .prepare(
      `SELECT e.local_date, e.started_at, e.started_at_time_known, e.ended_at, e.severity,
              e.meds, e.note, e.self_reported_triggers, e.self_reported_type, e.source,
              d.pressure_mean_hpa, d.pressure_delta_24h, d.temp_mean_c, d.humidity_mean,
              d.sleep_minutes
         FROM episodes e
         LEFT JOIN days d ON d.local_date = e.local_date
        ORDER BY e.local_date DESC`
    )
    .all<Record<string, unknown>>();

  const header = [
    "local_date", "started_at", "start_time_known", "ended_at", "duration_hours",
    "peak_severity_0_10", "meds", "cycle_day", "perimenstrual",
    "pressure_mean_hpa", "pressure_change_24h", "temp_mean_c", "humidity_mean", "sleep_minutes",
    "self_reported_triggers", "self_reported_type", "source", "note",
  ];

  const lines = [header.join(",")];
  for (const r of rows.results) {
    const start = r.started_at as string;
    const end = r.ended_at as string | null;
    const hours = end ? ((Date.parse(end) - Date.parse(start)) / 3600000).toFixed(2) : "";
    const ctx = cycleContext(r.local_date as string, starts);
    lines.push(
      [
        r.local_date, start, r.started_at_time_known, end ?? "", hours,
        r.severity ?? "", r.meds ?? "",
        ctx.cycle_day ?? "", ctx.perimenstrual === null ? "" : ctx.perimenstrual ? "yes" : "no",
        r.pressure_mean_hpa ?? "", r.pressure_delta_24h ?? "", r.temp_mean_c ?? "",
        r.humidity_mean ?? "", r.sleep_minutes ?? "",
        r.self_reported_triggers ?? "", r.self_reported_type ?? "", r.source, r.note ?? "",
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}

export async function doctorHtml(db: D1Database): Promise<string> {
  const s = await buildSummary(db);
  const complete = s.months.filter((m) => m.complete);
  const meanMhd = complete.length
    ? (complete.reduce((a, m) => a + m.headache_days, 0) / complete.length).toFixed(1)
    : "n/a";

  const maxDays = Math.max(1, ...s.months.map((m) => m.headache_days));
  const monthRows = s.months
    .map(
      (m) => `<tr${m.complete ? "" : ' class="partial"'}>
        <td>${html(m.month)}${m.complete ? "" : " *"}</td>
        <td class="num">${m.headache_days}</td>
        <td class="num">${m.avg_severity ?? "-"}</td>
        <td><span class="bar" style="width:${(m.headache_days / maxDays) * 100}%"></span></td>
      </tr>`
    )
    .join("");

  const medRows = s.medication_days.length
    ? s.medication_days
        .map(
          (m) => `<tr>
        <td>${html(m.month)}</td>
        <td class="num">${m.medication_days}</td>
        <td class="num${m.triptan_threshold_reached ? " flag" : ""}">${m.triptan_days}</td>
        <td class="num${m.analgesic_threshold_reached ? " flag" : ""}">${m.simple_analgesic_days}</td>
        <td class="num">${m.unclassified_days}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="5">No medication entries recorded.</td></tr>`;

  const trendLine =
    s.trend.enough_data
      ? `Last 3 complete months: ${s.trend.recent_mean_headache_days} headache days/month, against ${s.trend.prior_mean_headache_days} in the previous 3 (${s.trend.percent_change}%).`
      : "Not enough complete months to compare quarters.";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Aura headache summary</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color:#111; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: 0; }
  .sub { color:#555; margin-top:.25rem; }
  table { border-collapse: collapse; width: 100%; margin: .75rem 0 1.5rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e5e5; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing:.04em; color:#555; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { display:inline-block; height:.6rem; background:#6366f1; border-radius:2px; }
  .partial td { color:#999; }
  .flag { color:#b91c1c; font-weight:600; }
  .note { background:#f6f6f6; padding:.75rem 1rem; border-radius:6px; font-size:.85rem; color:#333; }
  @media print { body { margin: 0; } .noprint { display:none; } }
</style></head><body>
<h1>Headache summary</h1>
<p class="sub">${html(s.first_day)} to ${html(s.last_day)} &middot; ${s.headache_days} headache days &middot; mean peak severity ${s.mean_peak_severity ?? "-"} / 10</p>

<p class="note"><strong>How to read this.</strong> These are <strong>monthly headache days</strong>, not monthly migraine days: ICHD-3 criteria cannot be verified for the imported diary, so no attack is classified as migraine. Episodes imported from a written diary have no end time, so duration is unavailable for them. Aura records and counts; it does not diagnose and does not recommend treatment.</p>

<h2>Monthly headache days</h2>
<p>Mean over complete months: <strong>${meanMhd}</strong>. ${html(trendLine)}</p>
<table><thead><tr><th>Month</th><th class="num">Headache days</th><th class="num">Mean peak severity</th><th></th></tr></thead>
<tbody>${monthRows}</tbody></table>
<p class="sub">* partially observed month, excluded from the trend.</p>

<h2>Acute medication days per month</h2>
<p class="sub">ICHD-3 medication-overuse thresholds: triptans/ergots/opioids/combination on &ge;10 days per month, simple analgesics on &ge;15, sustained for more than 3 months. Counts shown in red reached the day count for that class in that month. This is information for a clinician, not a diagnosis.</p>
<table><thead><tr><th>Month</th><th class="num">Any medication</th><th class="num">Triptan</th><th class="num">Simple analgesic</th><th class="num">Unclassified</th></tr></thead>
<tbody>${medRows}</tbody></table>

<h2>Notes</h2>
<ul>
${s.insights.map((i) => `<li><strong>${html(i.title)}.</strong> ${html(i.body)}</li>`).join("")}
</ul>

<p class="noprint sub">Print this page to PDF from your browser.</p>
</body></html>`;
}

// F16: the Obsidian export-back.
//
// A single markdown snapshot she can drop into her vault so the Dataview dashboards
// she likes keep working. The rollup lives in YAML frontmatter (Dataview reads it at
// the page level); the detail is human-readable tables. It is a READ-ONLY snapshot:
// the app is the source of truth, so the header says to edit there, not here.
//
// Every honesty rule from the app carries over: headache days and migraine days are
// separate, imported rows are marked and never classified, an estimated onset shows
// a "~", and the migraine verdict is the criteria's, never a diagnosis.

/** Markdown table cells cannot contain a raw pipe or newline. */
const cell = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

const VERDICT_LABEL: Record<Ichd3Verdict, string> = {
  migraine_with_aura: "migraine (aura)",
  migraine_without_aura: "migraine",
  probable_migraine: "probable",
  tension_type_consistent: "tension-type",
  unclassified: "",
};

const b = (v: unknown): boolean | null => (v == null ? null : Boolean(v));

export async function obsidianMarkdown(db: D1Database, generated: string): Promise<string> {
  const s = await buildSummary(db);
  const rows = await db
    .prepare(
      `SELECT local_date, started_at, ended_at, started_at_time_known, severity, meds,
              side, quality, aggravated_by_activity, nausea, photophobia, phonophobia, aura,
              self_reported_triggers, note, source
         FROM episodes
        ORDER BY local_date DESC, started_at DESC`
    )
    .all<Record<string, unknown>>();

  const fm = [
    "---",
    "aura_snapshot: true",
    `generated: ${generated.slice(0, 10)}`,
    `range_start: ${s.first_day ?? ""}`,
    `range_end: ${s.last_day ?? ""}`,
    `episodes: ${s.episodes}`,
    `headache_days: ${s.headache_days}`,
    `migraine_days: ${s.migraine_days}`,
    `mean_peak_severity: ${s.mean_peak_severity ?? ""}`,
    "---",
    "",
  ];

  const head = [
    "# Aura migraine snapshot",
    "",
    `> Read-only snapshot generated by Aura on ${generated.slice(0, 10)}. Edit entries in the app, not here; re-run the export to refresh.`,
    "",
    `**${s.headache_days} headache days**, of which **${s.migraine_days} meet ICHD-3 migraine criteria** (${s.classified.attacks_with_attributes} attacks described so far). Migraine days come only from symptoms recorded in the app; the imported diary has none, so it counts as headache days only. Aura records and counts; it does not diagnose.`,
    "",
  ];

  const monthTable = [
    "## Monthly headache days",
    "",
    "| Month | Headache days | Mean peak severity | Complete |",
    "|---|--:|--:|:-:|",
    ...s.months.map(
      (m) =>
        `| ${m.month} | ${m.headache_days} | ${m.avg_severity ?? "-"} | ${m.complete ? "yes" : "no"} |`
    ),
    "",
  ];

  const medTable = s.medication_days.length
    ? [
        "## Acute medication days",
        "",
        "| Month | Any | Triptan | Simple analgesic | Unclassified |",
        "|---|--:|--:|--:|--:|",
        ...s.medication_days.map(
          (m) =>
            `| ${m.month} | ${m.medication_days} | ${m.triptan_days}${m.triptan_threshold_reached ? " ⚠️" : ""} | ${m.simple_analgesic_days}${m.analgesic_threshold_reached ? " ⚠️" : ""} | ${m.unclassified_days} |`
        ),
        "",
        "> ⚠️ marks a month that reached an ICHD-3 medication-overuse day count (triptans 10, simple analgesics 15). Information for a clinician, not a diagnosis.",
        "",
      ]
    : [];

  const epHeader = [
    "## Episodes",
    "",
    "| Date | Onset | Duration (h) | Peak | Side | Assessment | Meds | Self-reported triggers | Note | Source |",
    "|---|---|--:|--:|---|---|---|---|---|---|",
  ];
  const epRows = rows.results.map((r) => {
    const start = r.started_at as string;
    const end = r.ended_at as string | null;
    const known = r.started_at_time_known !== 0;
    const dur = end ? ((Date.parse(end) - Date.parse(start)) / 3600000).toFixed(1) : "";
    const durCell = dur && !known ? `~${dur}` : dur;
    const app = r.source === "app";
    const attrs: AttackAttributes = {
      side: (r.side as "one" | "both" | null) ?? null,
      quality: (r.quality as "throbbing" | "pressing" | null) ?? null,
      aggravated_by_activity: b(r.aggravated_by_activity),
      nausea: b(r.nausea),
      photophobia: b(r.photophobia),
      phonophobia: b(r.phonophobia),
      aura: b(r.aura),
      severity: (r.severity as number | null) ?? null,
      duration_hours: end ? (Date.parse(end) - Date.parse(start)) / 3600000 : null,
    };
    // Only app episodes carry attributes; imported rows stay explicitly unassessed.
    const verdict = app ? VERDICT_LABEL[classifyAttack(attrs).verdict] : "";
    const onset = known ? new Date(start).toISOString().slice(11, 16) : "~";
    return `| ${r.local_date} | ${onset} | ${cell(durCell)} | ${cell(r.severity ?? "")} | ${cell(r.side ?? "")} | ${cell(verdict)} | ${cell(r.meds ?? "")} | ${cell(r.self_reported_triggers ?? "")} | ${cell(r.note ?? "")} | ${r.source} |`;
  });

  return [
    ...fm,
    ...head,
    ...monthTable,
    ...medTable,
    ...epHeader,
    ...epRows,
    "",
  ].join("\n");
}

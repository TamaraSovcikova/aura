// The read surface: what the data says, and nothing else.
//
// It was nine peer sections in the order they happened to be built, with random
// chrome (some carded, some bare), two heading scales, and no difference in weight
// between an earned answer and a "not yet". Two adjacent sections both said
// "medication" while answering opposite questions, which read as redundancy.
//
// It is now ordered by the QUESTION each section answers, roughly in the order she
// would ask them, with three rules applied throughout:
//   1. One chrome rule. Sections are bare and separated by space; a card is only
//      used to group a sub-answer INSIDE a section.
//   2. One heading scale. Section titles are small uppercase; sub-questions inside
//      a section are sentence case. Nothing else invents a size.
//   3. Certainty is visible. An earned answer leads with the number. Something not
//      yet earned is one muted line saying what it still needs. They never look alike.
//
// Nothing here is written by a model, and no card softens a null result.

import { useCallback, useEffect, useState } from "react";
import type { CycleEvent, Episode } from "../shared/types";
import type { Summary } from "../worker/insights";
import type { TriggerAnalysis, FactorResult } from "../worker/triggers";
import type { MenstrualAnalysis } from "../worker/cycle";
import {
  apiCycleAnalysis,
  apiCycleList,
  apiList,
  apiMedResponse,
  apiPatterns,
  apiSummary,
  apiTriggers,
  exportCsvUrl,
  exportDoctorUrl,
  exportObsidianUrl,
  type Patterns as PatternsData,
  UnauthorizedError,
} from "./api";
import type { MedResponse } from "../worker/meds";
import { cycleContext, normalizeStarts } from "../shared/cycle";
import { localDateInTz } from "../shared/health";
import { currentTz } from "./geo";
import { HeadHeatMap } from "./HeadMap";
import { HEAD_REGIONS, parseRegions } from "../shared/headmap";

/** `2 Jan 2026`. Insights spans years, so unlike the log it always shows one. */
const fullDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The calendar day where she is standing, not where UTC happens to be. */
export const todayLocal = (): string => localDateInTz(new Date().toISOString(), currentTz());

/** Calendar arithmetic in UTC on a bare date, so a DST jump cannot move the day. */
export const shiftDay = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString([], {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });

// --- The three primitives every section is built from ----------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A sub-question inside a section. Sentence case, so it cannot be mistaken for a
 *  section of its own: that confusion is what made two medication sections read as
 *  one repeated thing. */
function SubHead({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-sm text-zinc-300">{children}</p>;
}

/** An answer that has been earned. Leads with the number. */
function Stat({ value, label, tone = "text-zinc-100" }: { value: string | number; label: string; tone?: string }) {
  return (
    <div>
      <div className={`text-3xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-xs text-zinc-400">{label}</div>
    </div>
  );
}

/** Something not yet earned. One muted line, always saying what it still needs, so
 *  a gate can never be mistaken for a finding. */
function Gate({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-zinc-500">{children}</p>;
}

// --- Sections ---------------------------------------------------------------

function Headline({ s }: { s: Summary }) {
  const complete = s.months.filter((m) => m.complete);
  const perMonth = complete.length
    ? (complete.reduce((a, m) => a + m.headache_days, 0) / complete.length).toFixed(1)
    : null;
  return (
    <section>
      <div className="flex items-baseline gap-8">
        <Stat value={s.headache_days} label="headache days" />
        <Stat value={s.migraine_days} label="migraine days" tone="text-rose-300" />
      </div>
      <p className="mt-3 text-sm text-zinc-400">
        {perMonth ? `About ${perMonth} a month. ` : ""}
        {s.episodes} episodes, {s.first_day ? fullDate(s.first_day) : "?"} to{" "}
        {s.last_day ? fullDate(s.last_day) : "?"}.
      </p>
    </section>
  );
}

function HowOften({ s }: { s: Summary }) {
  const months = s.months.slice(-14);
  const max = Math.max(1, ...months.map((m) => m.headache_days));
  const t = s.trend;
  return (
    <Section title="How often">
      {t.enough_data ? (
        <p className="mb-3 text-sm text-zinc-300">
          Last 3 complete months: {t.recent_mean_headache_days} a month, against{" "}
          {t.prior_mean_headache_days} in the 3 before ({t.percent_change ?? 0}%).
        </p>
      ) : (
        <div className="mb-3">
          <Gate>Not enough complete months yet to compare one quarter with the last.</Gate>
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {months.map((m) => (
          <li key={m.month} className="flex items-center gap-2 text-xs">
            <span className={`w-14 shrink-0 ${m.complete ? "text-zinc-300" : "text-zinc-400"}`}>
              {monthLabel(m.month)}
            </span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <span
                className={`block h-full rounded-full ${m.complete ? "bg-accent-500" : "bg-zinc-600"}`}
                style={{ width: `${(m.headache_days / max) * 100}%` }}
              />
            </span>
            <span
              className={`w-6 shrink-0 text-right tabular-nums ${
                m.complete ? "text-zinc-300" : "text-zinc-400"
              }`}
            >
              {m.headache_days}
            </span>
          </li>
        ))}
      </ul>
      {months.some((m) => !m.complete) && (
        <p className="mt-2 text-xs text-zinc-400">
          Grey months were only partly observed, so they sit out of the averages.
        </p>
      )}
    </Section>
  );
}

function MigraineOrHeadache({ s }: { s: Summary }) {
  const c = s.classified;
  const dayWord = s.migraine_days === 1 ? "day" : "days";
  return (
    <Section title="Migraine or headache">
      {c.attacks_with_attributes === 0 ? (
        <Gate>
          No attacks carry symptom details yet. Add them when an attack ends and Aura
          checks each against the ICHD-3 criteria.
        </Gate>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-zinc-200">
            {c.migraine} of {c.attacks_with_attributes} attacks you have described meet the
            ICHD-3 criteria for migraine
            {c.probable_migraine ? `, ${c.probable_migraine} probably do` : ""}. That is{" "}
            {s.migraine_days} migraine {dayWord}.
          </p>
          <p className="mt-1.5 text-xs text-zinc-400">
            Which criteria an attack meets, not a diagnosis. The imported diary has no
            symptoms, so it counts as headache days only.
          </p>
        </>
      )}
    </Section>
  );
}

/** Vertical bars with the value printed above each, so a bar never has to be read
 *  against an axis that is not there. */
function Bars({ items }: { items: Array<{ key: string; label: string; value: number; shown: string }> }) {
  const max = Math.max(0.0001, ...items.map((i) => i.value));
  return (
    <div className="flex items-end gap-1.5">
      {items.map((d) => (
        <div key={d.key} className="flex flex-1 flex-col items-center gap-1">
          <span className="text-[10px] tabular-nums text-zinc-400">{d.shown}</span>
          <div className="flex h-16 w-full items-end">
            <div
              className="w-full rounded-t bg-accent-500/80"
              style={{ height: `${Math.max(4, (d.value / max) * 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-zinc-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function WhenTheyHappen({ p }: { p: PatternsData }) {
  const dow = p.day_of_week;
  const tod = p.time_of_day;
  return (
    <Section title="When they happen">
      <SubHead>Across the week</SubHead>
      <Bars
        items={dow.per_day.map((d, i) => ({
          key: `${d.day}-${i}`,
          label: d.day.slice(0, 1),
          value: d.rate ?? 0,
          shown: d.rate == null ? "" : pct(d.rate),
        }))}
      />
      <p className="mt-1 text-[11px] text-zinc-500">Share of each weekday that was a headache day.</p>
      <div className="mt-2">
        {dow.verdict === "insufficient data" ? (
          <Gate>Not enough days yet to say whether a weekday matters.</Gate>
        ) : (
          <p className="text-xs text-zinc-400">
            {dow.verdict === "possible pattern"
              ? "Headache days lean toward some weekdays more than others (an association, not a cause)."
              : "No weekday carries more headache days than another."}
          </p>
        )}
      </div>

      <div className="mt-5">
        <SubHead>Across the day</SubHead>
        {tod.verdict !== "insufficient data" && (
          <div className="mb-2">
            <Bars
              items={tod.by_period.map((b) => ({
                key: b.label,
                label: b.label.split(" ")[0], // "morning (6-12)" -> "morning"
                value: b.count,
                shown: String(b.count),
              }))}
            />
          </div>
        )}
        {tod.verdict === "insufficient data" ? (
          <Gate>
            Needs 20 attacks with a known onset time ({tod.known_onset_attacks} so far).
          </Gate>
        ) : tod.verdict === "possible pattern" ? (
          <p className="text-sm text-zinc-200">
            Attacks tend to start around{" "}
            <span className="tabular-nums">{tod.peak_hour}</span>, across{" "}
            {tod.known_onset_attacks} with a known onset.
          </p>
        ) : (
          <p className="text-xs text-zinc-400">
            No time of day stands out, across {tod.known_onset_attacks} attacks with a
            known onset.
          </p>
        )}
      </div>
    </Section>
  );
}

/** ONE medication section. The two questions it answers are opposite (is it working
 *  / am I taking too much), and as separate sections they read as one thing repeated. */
function Medication({ s, m }: { s: Summary; m: MedResponse | null }) {
  const rows = s.medication_days.slice(-6);
  const minsLabel = (mins: number) =>
    mins < 90 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(1)} hr`;

  return (
    <Section title="Medication">
      <SubHead>Does it help?</SubHead>
      {!m || m.verdict !== "summary" ? (
        <Gate>
          {m?.message ??
            "No doses logged yet. Log one when you take something, and mark it when it helps."}
        </Gate>
      ) : (
        <div className="flex gap-3">
          <div className="flex-1 rounded-xl bg-zinc-900/60 p-3">
            <p className="text-2xl font-semibold tabular-nums text-zinc-100">
              {Math.round(m.overall.relief_rate * 100)}%
            </p>
            <p className="text-xs text-zinc-400">of {m.overall.doses} doses brought relief</p>
          </div>
          <div className="flex-1 rounded-xl bg-zinc-900/60 p-3">
            <p className="text-2xl font-semibold tabular-nums text-zinc-100">
              {m.overall.median_minutes_to_relief == null
                ? "–"
                : minsLabel(m.overall.median_minutes_to_relief)}
            </p>
            <p className="text-xs text-zinc-400">
              typical time to relief
              {m.overall.median_residual != null ? `, down to ${m.overall.median_residual}/10` : ""}
            </p>
          </div>
        </div>
      )}

      <div className="mt-5">
        <SubHead>How often are you taking it?</SubHead>
        {rows.length === 0 ? (
          <Gate>
            No medication recorded yet, so there is no day count to compare with the
            ICHD-3 overuse thresholds.
          </Gate>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-400">
                  <th className="pb-1 font-normal">Month</th>
                  <th className="pb-1 text-right font-normal">Any</th>
                  <th className="pb-1 text-right font-normal">Triptan</th>
                  <th className="pb-1 text-right font-normal">Analgesic</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {rows.map((mo) => (
                  <tr key={mo.month}>
                    <td className="py-1.5 text-zinc-400">{monthLabel(mo.month)}</td>
                    <td className="py-1.5 text-right tabular-nums text-zinc-300">
                      {mo.medication_days}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        mo.triptan_threshold_reached ? "font-semibold text-rose-400" : "text-zinc-300"
                      }`}
                    >
                      {mo.triptan_days}
                    </td>
                    <td
                      className={`py-1.5 text-right tabular-nums ${
                        mo.analgesic_threshold_reached
                          ? "font-semibold text-rose-400"
                          : "text-zinc-300"
                      }`}
                    >
                      {mo.simple_analgesic_days}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-zinc-400">
              Red flags an ICHD-3 overuse day count (triptans 10, analgesics 15). Sustained
              past three months, worth showing a neurologist.
            </p>
          </>
        )}
      </div>
    </Section>
  );
}

/** Where it hurts, across every attack that had its head map painted. */
function WhereItHurts({ episodes }: { episodes: Episode[] }) {
  const counts: Record<string, number> = {};
  let painted = 0;
  for (const e of episodes) {
    const regions = parseRegions(e.pain_regions);
    if (regions.length) painted++;
    for (const r of regions) counts[r] = (counts[r] ?? 0) + 1;
  }
  if (painted === 0) return null;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const topLabel = HEAD_REGIONS.find((r) => r.id === top[0])?.label ?? top[0];
  return (
    <Section title="Where it hurts">
      <HeadHeatMap counts={counts} />
      <p className="mt-2 text-sm text-zinc-200">
        Most often: {topLabel.toLowerCase()}, in {top[1]} of {painted} attacks with a painted map.
      </p>
      <p className="mt-1 text-xs text-zinc-400">Deeper red means painted more often.</p>
    </Section>
  );
}

/**
 * The weather test as a forest plot: for each factor, the stratified difference
 * between headache days and other days, with its 95% interval. A whisker that
 * crosses the centre line is "no evidence", and it is drawn that way, not softened.
 * Each row is scaled to itself because the factors are in different units.
 */
function ForestRow({ f }: { f: FactorResult }) {
  const lo = f.ci_low ?? 0;
  const hi = f.ci_high ?? 0;
  const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-9) * 1.15;
  const x = (v: number) => 50 + (v / span) * 50;
  const hit = f.verdict === "possible association";
  return (
    <li className="py-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-zinc-300">{f.label}</span>
        <span className={hit ? "text-rose-300" : "text-zinc-500"}>{hit ? "possible link" : "no evidence"}</span>
      </div>
      <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="mt-1 h-3 w-full" aria-hidden>
        <line x1={50} x2={50} y1={0} y2={10} className="stroke-zinc-600" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
        <line x1={x(lo)} x2={x(hi)} y1={5} y2={5} className={hit ? "stroke-rose-400" : "stroke-zinc-400"} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <rect x={x(f.adjusted_diff ?? 0) - 1} y={2} width={2} height={6} rx={1} className={hit ? "fill-rose-300" : "fill-zinc-200"} />
      </svg>
    </li>
  );
}

function Weather({ t }: { t: TriggerAnalysis }) {
  const tested = t.factors.filter((f) => f.verdict !== "insufficient data");
  const waiting = t.factors.filter((f) => f.verdict === "insufficient data");
  const hits = tested.filter((f) => f.verdict === "possible association");
  const n = tested[0];
  return (
    <Section title="Weather and other triggers">
      {tested.length === 0 ? (
        <Gate>Needs more days on record before any factor can be tested.</Gate>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-zinc-200">
            {hits.length
              ? `${hits.length} of ${tested.length} factors show a possible association. An association, not a cause.`
              : `None of ${tested.length} factors differs between headache days and other days.`}
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            {n.n_headache_days} headache days against {n.n_control_days} other days, compared within the
            same place and month, corrected for testing {tested.length} factors at once.
          </p>
          <div className="mt-2 flex justify-between text-[10px] text-zinc-500">
            <span>lower on headache days</span>
            <span>higher</span>
          </div>
          <ul className="divide-y divide-zinc-800/70">
            {tested.map((f) => (
              <ForestRow key={f.factor} f={f} />
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-zinc-500">
            Each line is the 95% range of the difference. A line crossing the centre is no evidence;
            one just clear of it can still be, because the verdict also corrects for testing several
            factors at once and ignores differences too small to matter.
          </p>
        </>
      )}
      {waiting.length > 0 && (
        <div className="mt-3">
          <Gate>
            Still collecting: {waiting.map((f) => f.label.replace(/ \(.*\)$/, "").toLowerCase()).join(", ")}.
          </Gate>
        </div>
      )}
    </Section>
  );
}

/** Cycle ANALYSIS only. Logging a period is a capture, and capture lives on Today:
 *  an action on the read screen was the reason "where do I log this" had no
 *  consistent answer. */
function Cycle({ events, a }: { events: CycleEvent[]; a: MenstrualAnalysis | null }) {
  const starts = normalizeStarts(events.map((e) => e.local_date));
  const ctx = cycleContext(todayLocal(), starts);
  const earned = a?.enough_data && a.odds_ratio !== null;

  return (
    <Section title="Cycle">
      {earned && a ? (
        <>
          <div className="flex items-baseline gap-3">
            <Stat
              value={`${a.odds_ratio!.toFixed(1)}×`}
              label="headache odds around a period"
              tone={a.verdict === "possible association" ? "text-rose-300" : "text-zinc-100"}
            />
          </div>
          <div className="mt-3 flex flex-col gap-1.5 text-xs">
            {[
              { label: "Days −2 to +3", rate: a.headache_rate_in_window ?? 0, tone: "bg-rose-400/80" },
              { label: "Rest of cycle", rate: a.headache_rate_outside ?? 0, tone: "bg-zinc-500" },
            ].map((r) => (
              <div key={r.label} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-zinc-400">{r.label}</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <span className={`block h-full rounded-full ${r.tone}`} style={{ width: pct(r.rate) }} />
                </span>
                <span className="w-9 shrink-0 text-right tabular-nums text-zinc-300">{pct(r.rate)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            Share of days that were headache days. 95% range {a.ci_low?.toFixed(1)} to{" "}
            {a.ci_high?.toFixed(1)}×,{" "}
            {a.verdict === "possible association" ? "a possible association, not a cause" : a.verdict}.
          </p>
        </>
      ) : (
        <Gate>
          {starts.length === 0
            ? "No period starts logged yet. One tap a month on Today is all this needs."
            : `${starts.length} period start${starts.length === 1 ? "" : "s"} logged. The perimenstrual answer takes about six months of tapping to earn.`}
        </Gate>
      )}
      {ctx.cycle_day !== null && (
        <p className="mt-2 text-xs text-zinc-500">Today is day {ctx.cycle_day} of the current cycle.</p>
      )}
    </Section>
  );
}

/** Everything still gated, in one collapsed place, so four "insufficient data" cards
 *  stop shouting from the middle of the screen. Sections shown above are left out. */
const SURFACED = new Set([
  "Is it getting worse?",
  "Migraine or headache?",
  "Menstrual cycle",
  "Weather and your headaches",
]);

function StillLearning({ s }: { s: Summary }) {
  const [open, setOpen] = useState(false);
  const items = s.insights.filter((i) => i.kind === "gated" && !SURFACED.has(i.title));
  if (items.length === 0) return null;
  const names = items.map((i) => i.title.replace(/"/g, "").toLowerCase());
  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center justify-between"
      >
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          More results
        </h3>
        <span className="text-lg text-zinc-400">{open ? "–" : "+"}</span>
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-3">
          {items.map((i) => (
            <li key={i.title}>
              <SubHead>{i.title}</SubHead>
              <Gate>{i.body}</Gate>
            </li>
          ))}
        </ul>
      ) : (
        <Gate>
          {names.join(", ").replace(/^./, (c) => c.toUpperCase())}. Tap to see where each stands.
        </Gate>
      )}
    </section>
  );
}

function Exports({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (kind: "csv" | "doctor" | "obsidian") => {
    setBusy(kind);
    try {
      const url =
        kind === "csv"
          ? await exportCsvUrl()
          : kind === "obsidian"
            ? await exportObsidianUrl()
            : await exportDoctorUrl();
      const a = document.createElement("a");
      a.href = url;
      if (kind === "csv") a.download = "aura-episodes.csv";
      else if (kind === "obsidian") a.download = "Aura-snapshot.md";
      else {
        a.target = "_blank";
        a.rel = "noopener";
      }
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Export">
      <div className="flex gap-2">
        <button
          disabled={busy !== null}
          onClick={() => download("doctor")}
          className="flex-1 rounded-lg bg-zinc-800 min-h-11 py-2.5 text-sm text-zinc-200 transition active:scale-95 disabled:opacity-50"
        >
          {busy === "doctor" ? "Preparing…" : "Summary to print"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => download("csv")}
          className="rounded-lg bg-zinc-800 px-4 min-h-11 py-2.5 text-sm text-zinc-400 transition active:scale-95 disabled:opacity-50"
        >
          {busy === "csv" ? "…" : "CSV"}
        </button>
      </div>
      <button
        disabled={busy !== null}
        onClick={() => download("obsidian")}
        className="mt-2 w-full rounded-lg bg-zinc-800 min-h-11 py-2.5 text-sm text-zinc-400 transition active:scale-95 disabled:opacity-50"
      >
        {busy === "obsidian" ? "…" : "Obsidian snapshot (.md)"}
      </button>
      <p className="mt-2 text-xs text-zinc-400">
        The summary opens in a new tab to print to PDF.
      </p>
    </Section>
  );
}

// --- The screen -------------------------------------------------------------

export default function Insights({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cycle, setCycle] = useState<CycleEvent[]>([]);
  const [patterns, setPatterns] = useState<PatternsData | null>(null);
  const [meds, setMeds] = useState<MedResponse | null>(null);
  const [triggers, setTriggers] = useState<TriggerAnalysis | null>(null);
  const [cycleAnalysis, setCycleAnalysis] = useState<MenstrualAnalysis | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c, p, m, t, ca, eps] = await Promise.all([
        apiSummary(),
        apiCycleList(),
        apiPatterns(),
        apiMedResponse(),
        apiTriggers(),
        apiCycleAnalysis(),
        apiList(500),
      ]);
      setSummary(s);
      setCycle(c);
      setPatterns(p);
      setMeds(m);
      setTriggers(t);
      setCycleAnalysis(ca);
      setEpisodes(eps);
      setError(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) return onUnauthorized();
      setError("Could not load your numbers. They need a connection.");
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="mt-16 text-center text-sm text-zinc-400">{error}</p>;
  if (!summary) return <p className="mt-16 text-center text-sm text-zinc-400">Counting…</p>;
  if (summary.episodes === 0) {
    return (
      <p className="mt-16 text-center text-sm text-zinc-400">
        Nothing logged yet. The numbers appear once there is something to count.
      </p>
    );
  }

  // Ordered by the question, not by when each was built.
  return (
    <div className="flex flex-col gap-9 pb-4">
      <Headline s={summary} />
      <HowOften s={summary} />
      <MigraineOrHeadache s={summary} />
      <WhereItHurts episodes={episodes} />
      {patterns && <WhenTheyHappen p={patterns} />}
      {triggers && <Weather t={triggers} />}
      <Medication s={summary} m={meds} />
      <Cycle events={cycle} a={cycleAnalysis} />
      <StillLearning s={summary} />
      <Exports onUnauthorized={onUnauthorized} />
    </div>
  );
}

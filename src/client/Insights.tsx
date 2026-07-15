// F5 / F6 / F7 / F8 / F13: the insights screen.
//
// Everything shown here is computed on the server from what she logged. Nothing
// is written by a model, and no card softens a null result into "a slight trend".
// A card that depends on a statistical test carries that test's gate in its own
// text, so a number that is not yet earned simply does not appear.

import { useCallback, useEffect, useState } from "react";
import type { CycleEvent } from "../shared/types";
import type { Summary } from "../worker/insights";
import {
  apiCycleDelete,
  apiCycleList,
  apiLogPeriod,
  apiMedResponse,
  apiPatterns,
  apiSummary,
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

/** The calendar day where she is standing, not where UTC happens to be. A tap at
 *  01:00 in Berlin is today's period, not yesterday's. */
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

export default function Insights({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cycle, setCycle] = useState<CycleEvent[]>([]);
  const [patterns, setPatterns] = useState<PatternsData | null>(null);
  const [meds, setMeds] = useState<MedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c, p, m] = await Promise.all([
        apiSummary(),
        apiCycleList(),
        apiPatterns(),
        apiMedResponse(),
      ]);
      setSummary(s);
      setCycle(c);
      setPatterns(p);
      setMeds(m);
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

  return (
    <div className="flex flex-col gap-9 pb-4">
      <Header s={summary} />
      <MonthChart s={summary} />
      <MigraineVsHeadache s={summary} />
      {patterns && <Patterns p={patterns} />}
      {meds && meds.verdict === "summary" && <MedResponseCard m={meds} />}
      <MedTable s={summary} />
      <CycleCard events={cycle} onChange={load} onUnauthorized={onUnauthorized} />
      <StillLearning s={summary} />
      <Exports onUnauthorized={onUnauthorized} />
    </div>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div>
      <div className={`text-3xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-xs text-zinc-400">{label}</div>
    </div>
  );
}

/** The headline: the two numbers a doctor reads, and the shape of a typical month.
 *  This absorbs what used to be three separate cards. */
function Header({ s }: { s: Summary }) {
  const complete = s.months.filter((m) => m.complete);
  const perMonth = complete.length
    ? (complete.reduce((a, m) => a + m.headache_days, 0) / complete.length).toFixed(1)
    : null;
  return (
    <section>
      <div className="flex items-baseline gap-8">
        <Stat value={s.headache_days} label="headache days" tone="text-zinc-100" />
        <Stat value={s.migraine_days} label="migraine days" tone="text-rose-300" />
      </div>
      <p className="mt-3 text-sm text-zinc-400">
        {perMonth ? `About ${perMonth} a month. ` : ""}
        {s.episodes} episodes, {s.first_day} to {s.last_day}.
      </p>
    </section>
  );
}

function MonthChart({ s }: { s: Summary }) {
  const months = s.months.slice(-14);
  const max = Math.max(1, ...months.map((m) => m.headache_days));
  const t = s.trend;
  const trendLine = t.enough_data
    ? `Last 3 complete months: ${t.recent_mean_headache_days} a month, against ${t.prior_mean_headache_days} in the 3 before (${t.percent_change ?? 0}%).`
    : "Not enough complete months yet to compare one quarter with the last.";
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Headache days per month
      </h3>
      <p className="mb-3 text-xs text-zinc-400">{trendLine}</p>
      <ul className="flex flex-col gap-1.5">
        {months.map((m) => (
          <li key={m.month} className="flex items-center gap-2 text-xs">
            <span className={`w-14 shrink-0 ${m.complete ? "text-zinc-300" : "text-zinc-400"}`}>
              {monthLabel(m.month)}
            </span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <span
                className={`block h-full rounded-full ${
                  m.complete ? "bg-accent-500" : "bg-zinc-600"
                }`}
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
    </section>
  );
}

function MedTable({ s }: { s: Summary }) {
  const rows = s.medication_days.slice(-6);
  if (rows.length === 0) return null;
  return (
    <section>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Acute medication days
      </h3>
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
          {rows.map((m) => (
            <tr key={m.month}>
              <td className="py-1.5 text-zinc-400">{monthLabel(m.month)}</td>
              <td className="py-1.5 text-right tabular-nums text-zinc-300">
                {m.medication_days}
              </td>
              <td
                className={`py-1.5 text-right tabular-nums ${
                  m.triptan_threshold_reached ? "font-semibold text-rose-400" : "text-zinc-300"
                }`}
              >
                {m.triptan_days}
              </td>
              <td
                className={`py-1.5 text-right tabular-nums ${
                  m.analgesic_threshold_reached ? "font-semibold text-rose-400" : "text-zinc-300"
                }`}
              >
                {m.simple_analgesic_days}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-zinc-400">
        Red flags an ICHD-3 overuse day count (triptans 10, analgesics 15). Sustained
        past three months, worth showing a neurologist.
      </p>
    </section>
  );
}

function MedResponseCard({ m }: { m: MedResponse }) {
  const o = m.overall;
  const pct = Math.round(o.relief_rate * 100);
  const minsLabel = (mins: number) =>
    mins < 90 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(1)} hr`;
  return (
    <section>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Does the medication work?
      </h3>
      <div className="flex gap-3">
        <div className="flex-1 rounded-xl bg-zinc-900/60 p-3">
          <p className="text-2xl font-semibold tabular-nums text-zinc-100">{pct}%</p>
          <p className="text-xs text-zinc-400">of {o.doses} doses brought relief</p>
        </div>
        <div className="flex-1 rounded-xl bg-zinc-900/60 p-3">
          <p className="text-2xl font-semibold tabular-nums text-zinc-100">
            {o.median_minutes_to_relief == null ? "–" : minsLabel(o.median_minutes_to_relief)}
          </p>
          <p className="text-xs text-zinc-400">
            typical time to relief
            {o.median_residual != null ? `, down to ${o.median_residual}/10` : ""}
          </p>
        </div>
      </div>
      {m.by_medication.length > 1 && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-400">
              <th className="pb-1 font-normal">Medication</th>
              <th className="pb-1 text-right font-normal">Doses</th>
              <th className="pb-1 text-right font-normal">Worked</th>
              <th className="pb-1 text-right font-normal">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {m.by_medication.map((g) => (
              <tr key={g.medication}>
                <td className="py-1.5 text-zinc-300">{g.medication}</td>
                <td className="py-1.5 text-right tabular-nums text-zinc-300">{g.doses}</td>
                <td className="py-1.5 text-right tabular-nums text-zinc-300">
                  {Math.round(g.relief_rate * 100)}%
                </td>
                <td className="py-1.5 text-right tabular-nums text-zinc-300">
                  {g.median_minutes_to_relief == null ? "–" : minsLabel(g.median_minutes_to_relief)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-zinc-400">
        A dose with no "I feel better" logged counts as one that did not help.
      </p>
    </section>
  );
}

function CycleCard({
  events,
  onChange,
  onUnauthorized,
}: {
  events: CycleEvent[];
  onChange: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const today = todayLocal();
  const starts = normalizeStarts(events.map((e) => e.local_date));
  const loggedToday = events.find((e) => e.local_date === today);
  const ctx = cycleContext(today, starts);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-zinc-900/60 p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Cycle</h3>

      <p className="mt-2 text-sm text-zinc-300">
        {ctx.cycle_day !== null
          ? `Day ${ctx.cycle_day} of your cycle.`
          : starts.length === 0
            ? "No period starts logged yet."
            : "Cycle day unknown: the last start is too long ago to count from."}
      </p>

      {loggedToday ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm text-accent-400">Period logged today.</span>
          <button
            disabled={busy}
            onClick={() => run(() => apiCycleDelete(loggedToday.id))}
            className="flex min-h-11 items-center px-1 text-xs text-zinc-400 underline disabled:opacity-50"
          >
            Undo
          </button>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={() => run(() => apiLogPeriod(today))}
            className="flex-1 rounded-lg bg-zinc-800 min-h-11 py-2.5 text-sm text-zinc-200 transition active:scale-95 disabled:opacity-50"
          >
            Period started today
          </button>
          <button
            disabled={busy}
            onClick={() => run(() => apiLogPeriod(shiftDay(today, -1)))}
            className="rounded-lg bg-zinc-800 px-3 min-h-11 py-2.5 text-xs text-zinc-400 transition active:scale-95 disabled:opacity-50"
          >
            Yesterday
          </button>
        </div>
      )}

      <p className="mt-3 text-xs text-zinc-400">
        {starts.length} logged. One tap a month; the answer takes about six months of
        tapping to earn.
      </p>
    </section>
  );
}

/** Where the migraine-day number comes from. One compact callout instead of a card
 *  buried in a list, because turning headache days into migraine days is the whole
 *  point of recording symptoms. */
function MigraineVsHeadache({ s }: { s: Summary }) {
  const c = s.classified;
  const dayWord = s.migraine_days === 1 ? "day" : "days";
  return (
    <section className="rounded-xl bg-zinc-900/60 p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
        Migraine or headache
      </h3>
      {c.attacks_with_attributes === 0 ? (
        <p className="mt-2 text-sm text-zinc-300">
          No attacks carry symptom details yet. Add them when an attack ends and Aura
          checks each against the ICHD-3 criteria.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed text-zinc-200">
            {c.migraine} of {c.attacks_with_attributes} attacks you have described meet
            the ICHD-3 criteria for migraine
            {c.probable_migraine ? `, ${c.probable_migraine} probably do` : ""}. That is{" "}
            {s.migraine_days} migraine {dayWord}.
          </p>
          <p className="mt-1.5 text-xs text-zinc-400">
            Which criteria an attack meets, not a diagnosis. The imported diary has no
            symptoms, so it counts as headache days only.
          </p>
        </>
      )}
    </section>
  );
}

/** When they happen: day-of-week and time-of-day, both on data already captured.
 *  A tiny weekday bar plus a one-line verdict each; nothing shouts. */
function Patterns({ p }: { p: PatternsData }) {
  const dow = p.day_of_week;
  const tod = p.time_of_day;
  const maxRate = Math.max(0.01, ...dow.per_day.map((d) => d.rate ?? 0));
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
        When they happen
      </h3>

      <div className="flex items-end gap-1.5">
        {dow.per_day.map((d) => (
          <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
            <div className="flex h-16 w-full items-end">
              <div
                className="w-full rounded-t bg-accent-500/80"
                style={{ height: `${((d.rate ?? 0) / maxRate) * 100}%` }}
              />
            </div>
            <span className="text-[10px] text-zinc-400">{d.day.slice(0, 1)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        {dow.verdict === "insufficient data"
          ? "Day of week: not enough days yet."
          : dow.verdict === "possible pattern"
            ? "Headache days lean toward some weekdays more than others (an association, not a cause)."
            : "No weekday carries more headache days than another."}
      </p>

      <p className="mt-3 text-xs text-zinc-400">
        {tod.verdict === "insufficient data"
          ? `Time of day: needs 20 attacks with a known onset (${tod.known_onset_attacks} so far).`
          : tod.verdict === "possible pattern"
            ? `Attacks tend to start around ${tod.peak_hour} (${tod.known_onset_attacks} with a known onset).`
            : `No time of day stands out, across ${tod.known_onset_attacks} attacks with a known onset.`}
      </p>
    </section>
  );
}

/** Weather, sleep and premonitions all need more data before they can say anything.
 *  Folded into one collapsed section so they stop shouting "insufficient data" from
 *  four separate cards. */
const SURFACED = new Set(["Is it getting worse?", "Migraine or headache?", "Menstrual cycle"]);

function StillLearning({ s }: { s: Summary }) {
  const [open, setOpen] = useState(false);
  const items = s.insights.filter((i) => i.kind === "gated" && !SURFACED.has(i.title));
  if (items.length === 0) return null;
  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center justify-between"
      >
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          Still being learned
        </h3>
        <span className="text-lg text-zinc-400">{open ? "–" : "+"}</span>
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-3">
          {items.map((i) => (
            <li key={i.title} className="rounded-xl bg-zinc-900/60 p-4">
              <h4 className="text-sm font-medium text-zinc-200">{i.title}</h4>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{i.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-zinc-400">
          Weather, sleep and premonitions each need more data before Aura will call
          anything. Tap to see where they stand.
        </p>
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
      // Give the browser a tick to take the blob before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Export
      </h3>
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
        {busy === "obsidian" ? "Preparing…" : "Obsidian snapshot (.md)"}
      </button>
      <p className="mt-2 text-xs text-zinc-400">
        The summary opens in a new tab to print to PDF.
      </p>
    </section>
  );
}

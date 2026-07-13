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
  apiSummary,
  exportCsvUrl,
  exportDoctorUrl,
  exportObsidianUrl,
  UnauthorizedError,
} from "./api";
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([apiSummary(), apiCycleList()]);
      setSummary(s);
      setCycle(c);
      setError(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) return onUnauthorized();
      setError("Could not load your numbers. They need a connection.");
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="mt-16 text-center text-sm text-slate-500">{error}</p>;
  if (!summary) return <p className="mt-16 text-center text-sm text-slate-600">Counting…</p>;
  if (summary.episodes === 0) {
    return (
      <p className="mt-16 text-center text-sm text-slate-500">
        Nothing logged yet. The numbers appear once there is something to count.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8 pb-4">
      <Header s={summary} />
      <MonthChart s={summary} />
      <MedTable s={summary} />
      <CycleCard events={cycle} onChange={load} onUnauthorized={onUnauthorized} />
      <Cards s={summary} />
      <Exports onUnauthorized={onUnauthorized} />
    </div>
  );
}

function Header({ s }: { s: Summary }) {
  return (
    <section>
      <div className="flex items-baseline gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-100 tabular-nums">
            {s.headache_days}
          </h2>
          <p className="text-xs text-slate-500">headache days</p>
        </div>
        <div>
          <h2 className="text-2xl font-semibold text-rose-300 tabular-nums">
            {s.migraine_days}
          </h2>
          <p className="text-xs text-slate-500">migraine days</p>
        </div>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        {s.episodes} episodes, {s.first_day} to {s.last_day}.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">
        Migraine days are the ones meeting ICHD-3 criteria from the symptoms you
        recorded. The imported history has none, so it counts as headache days only.
      </p>
    </section>
  );
}

function MonthChart({ s }: { s: Summary }) {
  const months = s.months.slice(-14);
  const max = Math.max(1, ...months.map((m) => m.headache_days));
  return (
    <section>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        Headache days per month
      </h3>
      <ul className="flex flex-col gap-1.5">
        {months.map((m) => (
          <li key={m.month} className="flex items-center gap-2 text-xs">
            <span className={`w-14 shrink-0 ${m.complete ? "text-slate-400" : "text-slate-600"}`}>
              {monthLabel(m.month)}
            </span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-800">
              <span
                className={`block h-full rounded-full ${
                  m.complete ? "bg-indigo-500" : "bg-slate-600"
                }`}
                style={{ width: `${(m.headache_days / max) * 100}%` }}
              />
            </span>
            <span
              className={`w-6 shrink-0 text-right tabular-nums ${
                m.complete ? "text-slate-300" : "text-slate-600"
              }`}
            >
              {m.headache_days}
            </span>
          </li>
        ))}
      </ul>
      {months.some((m) => !m.complete) && (
        <p className="mt-2 text-xs text-slate-600">
          Grey months were only partly observed. They are excluded from every average,
          because averaging a part-month against full ones invents a change.
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
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        Acute medication days
      </h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-600">
            <th className="pb-1 font-normal">Month</th>
            <th className="pb-1 text-right font-normal">Any</th>
            <th className="pb-1 text-right font-normal">Triptan</th>
            <th className="pb-1 text-right font-normal">Analgesic</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows.map((m) => (
            <tr key={m.month}>
              <td className="py-1.5 text-slate-400">{monthLabel(m.month)}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-300">
                {m.medication_days}
              </td>
              <td
                className={`py-1.5 text-right tabular-nums ${
                  m.triptan_threshold_reached ? "font-semibold text-rose-400" : "text-slate-300"
                }`}
              >
                {m.triptan_days}
              </td>
              <td
                className={`py-1.5 text-right tabular-nums ${
                  m.analgesic_threshold_reached ? "font-semibold text-rose-400" : "text-slate-300"
                }`}
              >
                {m.simple_analgesic_days}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">
        Red means that month reached an ICHD-3 day count (triptans on 10 days, simple
        analgesics on 15). Sustained past three months, that is worth showing a
        neurologist. It is a count, not a diagnosis, and it is never inferred from an
        old trigger tag.
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
    <section className="rounded-xl bg-slate-900/60 p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Cycle</h3>

      <p className="mt-2 text-sm text-slate-300">
        {ctx.cycle_day !== null
          ? `Day ${ctx.cycle_day} of your cycle.`
          : starts.length === 0
            ? "No period starts logged yet."
            : "Cycle day unknown: the last start is too long ago to count from."}
      </p>

      {loggedToday ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm text-emerald-400">Period logged today.</span>
          <button
            disabled={busy}
            onClick={() => run(() => apiCycleDelete(loggedToday.id))}
            className="text-xs text-slate-500 underline disabled:opacity-50"
          >
            Undo
          </button>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={() => run(() => apiLogPeriod(today))}
            className="flex-1 rounded-lg bg-slate-800 py-2.5 text-sm text-slate-200 transition active:scale-95 disabled:opacity-50"
          >
            Period started today
          </button>
          <button
            disabled={busy}
            onClick={() => run(() => apiLogPeriod(shiftDay(today, -1)))}
            className="rounded-lg bg-slate-800 px-3 py-2.5 text-xs text-slate-400 transition active:scale-95 disabled:opacity-50"
          >
            Yesterday
          </button>
        </div>
      )}

      <p className="mt-3 text-xs leading-relaxed text-slate-600">
        {starts.length} logged. One tap a month is enough: the cycle day of every day in
        between is worked out from these dates, so days without a headache count too.
        There is no cycle data in your old notes, so this question can only be answered
        forwards, from about six months of tapping.
      </p>
    </section>
  );
}

function Cards({ s }: { s: Summary }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        What the data says
      </h3>
      <ul className="flex flex-col gap-3">
        {s.insights.map((i) => (
          <li key={i.title} className="rounded-xl bg-slate-900/60 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="text-sm font-medium text-slate-200">{i.title}</h4>
              {i.kind === "gated" && (
                <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                  tested
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{i.body}</p>
          </li>
        ))}
      </ul>
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
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        Export
      </h3>
      <div className="flex gap-2">
        <button
          disabled={busy !== null}
          onClick={() => download("doctor")}
          className="flex-1 rounded-lg bg-slate-800 py-2.5 text-sm text-slate-200 transition active:scale-95 disabled:opacity-50"
        >
          {busy === "doctor" ? "Preparing…" : "Summary to print"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => download("csv")}
          className="rounded-lg bg-slate-800 px-4 py-2.5 text-sm text-slate-400 transition active:scale-95 disabled:opacity-50"
        >
          {busy === "csv" ? "…" : "CSV"}
        </button>
      </div>
      <button
        disabled={busy !== null}
        onClick={() => download("obsidian")}
        className="mt-2 w-full rounded-lg bg-slate-800 py-2.5 text-sm text-slate-400 transition active:scale-95 disabled:opacity-50"
      >
        {busy === "obsidian" ? "Preparing…" : "Obsidian snapshot (.md)"}
      </button>
      <p className="mt-2 text-xs text-slate-600">
        The summary opens in a new tab to print to PDF. The Obsidian snapshot is a
        read-only markdown file for your vault; re-download it to refresh.
      </p>
    </section>
  );
}

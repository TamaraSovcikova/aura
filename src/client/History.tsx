import { useState } from "react";
import { SEVERITY_MAX, type Episode } from "../shared/types";
import { classifyAttack, hasAnyAttribute, rowToAttackAttributes } from "../shared/ichd3";
import { attackTimes, dayShort } from "./time";

// The log, on its own surface.
//
// It used to show a start time, a severity and a duration, and stopped there: the
// end time, what the attack was, and what was taken for it were all invisible until
// you opened the edit sheet. It also only ever fetched the 20 most recent rows, so
// most of a two-year history simply could not be reached.
//
// A row now answers, in scanning order: when, how long, how bad, what it was, and
// what was done about it. Times and their estimate markers come from ./time, so the
// log cannot drift from the live screen or the sheet.


const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString([], {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** What the recorded symptoms make this attack, in one word. Never a diagnosis:
 *  it is which ICHD-3 criteria the description meets, and only ever for attacks
 *  that carry a description at all. */
export function verdictLabel(e: Episode): { text: string; tone: string } | null {
  const imported = Boolean(e.source && e.source !== "app");
  // The imported diary has no symptoms, so it is never classified. Saying
  // "unclassified" for 200 rows would be noise, not information.
  if (imported || !hasAnyAttribute(e as unknown as Record<string, unknown>)) return null;
  const v = classifyAttack(rowToAttackAttributes(e as unknown as Record<string, unknown>));
  switch (v.verdict) {
    case "migraine_with_aura":
      return { text: "migraine (aura)", tone: "text-rose-300" };
    case "migraine_without_aura":
      return { text: "migraine", tone: "text-rose-300" };
    case "probable_migraine":
      return { text: "probable migraine", tone: "text-zinc-300" };
    case "tension_type_consistent":
      return { text: "tension-type", tone: "text-zinc-400" };
    default:
      return null;
  }
}

function medLabel(e: Episode): string | null {
  const n = e.dose_count ?? 0;
  if (n === 0) {
    // A legacy free-text entry still says something was taken, even without doses.
    return e.meds && e.meds.trim() ? "medication" : null;
  }
  const relieved = e.dose_relief_count ?? 0;
  const doses = n === 1 ? "1 dose" : `${n} doses`;
  return relieved > 0 ? `${doses}, helped` : doses;
}

function Row({ e, onSelect }: { e: Episode; onSelect: (e: Episode) => void }) {
  const t = attackTimes(e);
  const imported = Boolean(e.source && e.source !== "app");
  const verdict = verdictLabel(e);
  const meds = medLabel(e);

  // Second line: what it was and what was done. Only what exists is shown, so a
  // sparse row stays quiet instead of filling with dashes.
  const meta: Array<{ text: string; tone: string }> = [];
  if (e.severity !== null) {
    meta.push({ text: `${e.severity}/${SEVERITY_MAX}`, tone: "text-zinc-300" });
  }
  if (verdict) meta.push(verdict);
  if (meds) meta.push({ text: meds, tone: "text-zinc-400" });
  if (imported) meta.push({ text: "imported", tone: "text-zinc-500" });

  return (
    <li>
      <button
        onClick={() => onSelect(e)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition active:bg-zinc-800/60"
      >
        <span className="min-w-0">
          <span className="block text-sm text-zinc-200">
            {dayShort(e.started_at)} · {t.start}
            <span className="text-zinc-400">
              {t.endState === "ended" ? ` → ${t.end}` : ` · ${t.end}`}
            </span>
          </span>
          {meta.length > 0 && (
            <span className="mt-0.5 block text-xs">
              {meta.map((m, i) => (
                <span key={m.text} className={m.tone}>
                  {i > 0 && <span className="text-zinc-600"> · </span>}
                  {m.text}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="shrink-0 text-sm tabular-nums text-zinc-300">
          {t.duration ?? ""}
        </span>
      </button>
    </li>
  );
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/** The calendar day an attack belongs to: its local date, falling back to UTC. */
const dayOf = (e: Episode) => e.local_date ?? e.started_at.slice(0, 10);

/** Cell fill for a day's worst severity. Unknown severity still marks the day. */
function dayFill(sev: number | null): React.CSSProperties {
  if (sev === null) return { background: "rgba(244, 63, 94, 0.28)" };
  const a = 0.18 + (Math.min(sev, SEVERITY_MAX) / SEVERITY_MAX) * 0.72;
  return { background: `rgba(244, 63, 94, ${a.toFixed(2)})` };
}

/**
 * One month as a grid, Monday first. A day with an attack is shaded by the worst
 * severity logged that day; a dot marks a day medication was taken. Tapping a
 * shaded day selects it, and the list under the calendar narrows to that day.
 */
function MonthGrid({
  monthKey: key,
  rows,
  selectedDay,
  today,
  onPickDay,
}: {
  monthKey: string;
  rows: Episode[];
  selectedDay: string | null;
  today: string;
  onPickDay: (day: string | null) => void;
}) {
  const byDay = new Map<string, Episode[]>();
  for (const e of rows) {
    const d = dayOf(e);
    byDay.set(d, [...(byDay.get(d) ?? []), e]);
  }
  const first = new Date(`${key}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const daysIn = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();

  const cells: Array<{ date: string; day: number } | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysIn }, (_, i) => ({
      date: `${key}-${String(i + 1).padStart(2, "0")}`,
      day: i + 1,
    })),
  ];

  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] text-zinc-500">
        {WEEKDAYS.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-7 gap-1.5">
        {cells.map((c, i) => {
          if (!c) return <span key={`pad-${i}`} />;
          const hits = byDay.get(c.date);
          const isToday = c.date === today;
          if (!hits) {
            return (
              <span
                key={c.date}
                className={`flex aspect-square items-center justify-center rounded-lg bg-zinc-800/40 text-xs tabular-nums ${
                  isToday ? "text-zinc-100 ring-1 ring-zinc-500" : "text-zinc-500"
                }`}
              >
                {c.day}
              </span>
            );
          }
          const sevs = hits.map((h) => h.severity).filter((s): s is number => s !== null);
          const worst = sevs.length ? Math.max(...sevs) : null;
          const medicated = hits.some((h) => (h.dose_count ?? 0) > 0 || Boolean(h.meds?.trim()));
          const selected = selectedDay === c.date;
          return (
            <button
              key={c.date}
              onClick={() => onPickDay(selected ? null : c.date)}
              aria-pressed={selected}
              aria-label={`${dayShort(hits[0].started_at)}: ${hits.length === 1 ? "1 attack" : `${hits.length} attacks`}${worst !== null ? `, worst ${worst}/${SEVERITY_MAX}` : ""}${medicated ? ", medication taken" : ""}`}
              style={dayFill(worst)}
              className={`relative flex aspect-square items-center justify-center rounded-lg text-xs font-medium tabular-nums text-white transition active:scale-95 ${
                selected ? "ring-2 ring-white" : isToday ? "ring-1 ring-zinc-300" : ""
              }`}
            >
              {c.day}
              {medicated && (
                <span aria-hidden className="absolute bottom-1 h-1 w-1 rounded-full bg-white/85" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center justify-between text-[11px] text-zinc-400">
      <span className="flex items-center gap-2">
        mild
        <span
          aria-hidden
          className="h-2 w-20 rounded-full"
          style={{ background: "linear-gradient(90deg, rgba(244,63,94,0.25), rgba(244,63,94,0.9))" }}
        />
        severe
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
        medication
      </span>
    </div>
  );
}

/** Every month from `from` to `to` inclusive, as YYYY-MM keys. */
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function Summary({ rows }: { rows: Episode[] }) {
  const days = new Set(rows.map(dayOf)).size;
  const migraine = rows.filter((e) => verdictLabel(e)?.text.startsWith("migraine")).length;
  const sevs = rows.map((e) => e.severity).filter((s): s is number => s !== null);
  const doses = rows.reduce((a, e) => a + (e.dose_count ?? 0), 0);
  const items = [
    { v: days, l: days === 1 ? "headache day" : "headache days" },
    { v: migraine, l: "migraine" },
    { v: sevs.length ? `${Math.max(...sevs)}/${SEVERITY_MAX}` : "–", l: "worst" },
    { v: doses, l: doses === 1 ? "dose" : "doses" },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {items.map((it) => (
        <div key={it.l} className="rounded-xl bg-zinc-900/60 px-2 py-2 text-center">
          <p className="text-lg font-semibold tabular-nums text-zinc-100">{it.v}</p>
          <p className="text-[10px] text-zinc-400">{it.l}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * The log as a calendar: one month at a time, stepped with arrows or picked from a
 * dropdown, with that month's numbers above the grid and its attacks below. Tapping
 * a day narrows the list to that day; tapping an attack opens it.
 *
 * It opens on the month of the latest attack, since that is what is looked up most.
 */
export default function History({
  episodes,
  onSelect,
}: {
  episodes: Episode[];
  onSelect: (e: Episode) => void;
}) {
  const latestMonth = episodes.length ? dayOf(episodes[0]).slice(0, 7) : localToday().slice(0, 7);
  const [month, setMonth] = useState(latestMonth);
  const [day, setDay] = useState<string | null>(null);

  if (episodes.length === 0) {
    return (
      <p className="mt-16 text-center text-sm text-zinc-400">
        Nothing logged yet. Attacks you record appear here.
      </p>
    );
  }

  const keys = episodes.map((e) => dayOf(e).slice(0, 7));
  const first = keys.reduce((a, b) => (a < b ? a : b));
  const lastKey = [keys.reduce((a, b) => (a > b ? a : b)), localToday().slice(0, 7)].sort().at(-1)!;
  const months = monthRange(first, lastKey);
  const idx = months.indexOf(month);
  const show = (m: string) => {
    setMonth(m);
    setDay(null);
  };

  const inMonth = episodes.filter((e) => dayOf(e).startsWith(month));
  const listed = day ? inMonth.filter((e) => dayOf(e) === day) : inMonth;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => show(months[idx - 1])}
          disabled={idx <= 0}
          aria-label="Previous month"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800/70 text-lg text-zinc-200 disabled:opacity-30"
        >
          ‹
        </button>
        <select
          value={month}
          onChange={(e) => show(e.target.value)}
          aria-label="Month"
          className="min-h-11 flex-1 appearance-none rounded-full bg-zinc-800/70 px-4 text-center text-base font-medium text-zinc-100 outline-none"
        >
          {[...months].reverse().map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
        <button
          onClick={() => show(months[idx + 1])}
          disabled={idx >= months.length - 1}
          aria-label="Next month"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800/70 text-lg text-zinc-200 disabled:opacity-30"
        >
          ›
        </button>
      </div>

      <Summary rows={inMonth} />

      <div className="rounded-2xl bg-zinc-900/60 p-3">
        <MonthGrid monthKey={month} rows={inMonth} selectedDay={day} today={localToday()} onPickDay={setDay} />
        <div className="mt-3">
          <Legend />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            {day ? dayShort(`${day}T12:00:00Z`) : `All of ${monthLabel(month).split(" ")[0]}`}
          </h2>
          {day && (
            <button onClick={() => setDay(null)} className="min-h-11 text-xs text-zinc-400 underline">
              show whole month
            </button>
          )}
        </div>
        {listed.length === 0 ? (
          <p className="rounded-xl bg-zinc-900/60 px-4 py-6 text-center text-sm text-zinc-500">
            No attacks logged this month.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-xl bg-zinc-900/60">
            {listed.map((e) => (
              <Row key={e.id} e={e} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

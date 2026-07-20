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

const monthKey = (iso: string) => iso.slice(0, 7);

const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString([], {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** What the recorded symptoms make this attack, in one word. Never a diagnosis:
 *  it is which ICHD-3 criteria the description meets, and only ever for attacks
 *  that carry a description at all. */
function verdictLabel(e: Episode): { text: string; tone: string } | null {
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

export default function History({
  episodes,
  onSelect,
}: {
  episodes: Episode[];
  onSelect: (e: Episode) => void;
}) {
  if (episodes.length === 0) {
    return (
      <p className="mt-16 text-center text-sm text-zinc-400">
        Nothing logged yet. Attacks you record appear here.
      </p>
    );
  }

  // Grouped by month so a long history is browsable rather than an endless column.
  const groups: Array<{ key: string; rows: Episode[] }> = [];
  for (const e of episodes) {
    const k = monthKey(e.started_at);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.rows.push(e);
    else groups.push({ key: k, rows: [e] });
  }

  return (
    <section className="flex flex-col gap-6">
      {groups.map((g) => (
        <div key={g.key}>
          <h2 className="mb-2 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-zinc-400">
            <span>{monthLabel(g.key)}</span>
            <span className="tabular-nums text-zinc-500">{g.rows.length}</span>
          </h2>
          <ul className="divide-y divide-zinc-800 rounded-xl bg-zinc-900/60">
            {g.rows.map((e) => (
              <Row key={e.id} e={e} onSelect={onSelect} />
            ))}
          </ul>
        </div>
      ))}
      <p className="text-center text-xs text-zinc-400">
        Tap an entry to edit or delete it.
      </p>
    </section>
  );
}

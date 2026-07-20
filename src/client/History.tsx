import { SEVERITY_MAX, type Episode } from "../shared/types";
import { attackTimes } from "./time";

// The log, on its own surface instead of stacked under the capture button.
//
// Every row shows BOTH times. The old list showed the start and a duration and never
// the end, so reading when an attack finished meant opening the edit sheet. It also
// printed an estimated onset as an exact clock time while marking only the duration,
// so one row contradicted itself. Both are decided in ./time now, not here.
//
// This is the lift onto its own tab plus the time fix. The richer, scannable version
// (migraine verdict, medication, symptoms) comes with the History pass.

function Row({ e, onSelect }: { e: Episode; onSelect: (e: Episode) => void }) {
  const t = attackTimes(e);
  const imported = Boolean(e.source && e.source !== "app");

  return (
    <li>
      <button
        onClick={() => onSelect(e)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition active:bg-zinc-800/60"
      >
        <span className="min-w-0">
          <span className="block text-sm text-zinc-200">{t.startFull}</span>
          <span className="mt-0.5 block text-xs text-zinc-400">
            {t.endState === "ended" ? `→ ${t.end}` : t.end}
            {imported && <span className="ml-2 text-zinc-500">imported</span>}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm tabular-nums text-zinc-300">
            {t.duration ?? "—"}
          </span>
          <span className="mt-0.5 block text-xs tabular-nums text-zinc-400">
            {e.severity !== null ? `${e.severity}/${SEVERITY_MAX}` : "—"}
          </span>
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
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
        {episodes.length} logged
      </h2>
      <ul className="divide-y divide-zinc-800 rounded-xl bg-zinc-900/60">
        {episodes.map((e) => (
          <Row key={e.id} e={e} onSelect={onSelect} />
        ))}
      </ul>
      <p className="mt-2 text-center text-xs text-zinc-400">
        Tap an entry to edit or delete it.
      </p>
    </section>
  );
}

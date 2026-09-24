import { SEVERITY_MAX, SEVERITY_MIN, SEVERITY_QUICK } from "../shared/types";

/**
 * One severity control, used wherever a 0-10 pain level is asked for. Quick presets
 * for a fast tap mid-migraine, a slider underneath for the exact number when there
 * is time. The chosen number is shown large with its word, so the two inputs read as
 * one answer rather than two competing ones; tapping the active preset clears it.
 *
 * The LABEL is a prop because the same scale answers different questions: how bad it
 * got at its worst, versus where the pain sat after a dose. Sharing the widget while
 * silently reusing the word "Severity" for both made the second one read as a
 * correction of the first.
 */

/** The word for a level, from the quick presets' own bands. */
export function severityWord(v: number): string {
  if (v === 0) return "none";
  const sorted = [...SEVERITY_QUICK].sort((a, b) => a.level - b.level);
  // Nearest preset by level decides the word, so 5 reads as moderate, 8 as severe.
  let best = sorted[0];
  for (const q of sorted) if (Math.abs(q.level - v) < Math.abs(best.level - v)) best = q;
  return best.label.toLowerCase();
}

export default function SeverityInput({
  value,
  onChange,
  label = "Severity",
  hint,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label?: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-sm text-zinc-300">{label}</p>
        <span className="text-sm tabular-nums text-zinc-400" aria-live="polite">
          {value === null ? (
            "not set"
          ) : (
            <>
              <span className="text-2xl font-semibold text-zinc-100">{value}</span>
              <span className="text-zinc-500">/{SEVERITY_MAX}</span> {severityWord(value)}
            </>
          )}
        </span>
      </div>
      <div className="flex gap-2">
        {SEVERITY_QUICK.map((l) => (
          <button
            key={l.level}
            onClick={() => onChange(value === l.level ? null : l.level)}
            aria-pressed={value === l.level}
            className={`flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm transition active:scale-95 ${
              value === l.level ? "bg-accent-500 text-white" : "bg-zinc-800 text-zinc-300"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <input
        type="range"
        min={SEVERITY_MIN}
        max={SEVERITY_MAX}
        step={1}
        value={value ?? 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`mt-3 w-full accent-accent-500 ${value === null ? "opacity-50" : ""}`}
        aria-label={label}
      />
      <div className="flex justify-between text-[10px] text-zinc-500">
        <span>0 none</span>
        <span>or slide for the exact number</span>
        <span>10 worst</span>
      </div>
      {hint && <p className="mt-1 text-[11px] leading-snug text-zinc-500">{hint}</p>}
    </div>
  );
}

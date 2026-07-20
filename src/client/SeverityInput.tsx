import { SEVERITY_MAX, SEVERITY_MIN, SEVERITY_QUICK } from "../shared/types";

/**
 * One severity control, used wherever a 0-10 pain level is asked for. Quick presets
 * for a fast tap mid-migraine, a slider underneath for the exact number when there
 * is time.
 *
 * The LABEL is a prop because the same scale answers different questions: how bad it
 * got at its worst, versus where the pain sat after a dose. Sharing the widget while
 * silently reusing the word "Severity" for both made the second one read as a
 * correction of the first.
 */
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
        <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
        <span className="text-sm tabular-nums text-zinc-300">
          {value === null ? "not set" : `${value}/${SEVERITY_MAX}`}
        </span>
      </div>
      <div className="flex gap-2">
        {SEVERITY_QUICK.map((l) => (
          <button
            key={l.level}
            onClick={() => onChange(value === l.level ? null : l.level)}
            className={`flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm transition ${
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
        className="mt-3 w-full accent-accent-500"
        aria-label={label}
      />
      <div className="flex justify-between text-[10px] text-zinc-400">
        <span>0 none</span>
        <span>10 worst</span>
      </div>
      {hint && <p className="mt-1 text-[11px] leading-snug text-zinc-500">{hint}</p>}
      {value !== null && (
        <button
          onClick={() => onChange(null)}
          className="mt-1 flex min-h-11 items-center px-1 text-xs text-zinc-400 underline"
        >
          clear
        </button>
      )}
    </div>
  );
}

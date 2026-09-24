// F18: the optional post-attack ICHD-3 attribute panel.
//
// Every field is tri-state: yes, no, or unrecorded. "Unrecorded" is the default and
// is preserved as null, because the classifier treats a missing answer as unknown,
// never as a no. Nothing here is required; a skipped panel just leaves an attack
// counted as a headache day, not a migraine day.
//
// The answers are chips rather than a Yes/No row each: six rows of paired buttons
// filled a whole phone screen. A chip cycles unrecorded -> yes -> no -> unrecorded,
// and says which state it is in words, so "no" never looks like "not asked".

import HeadMap from "./HeadMap";

export interface Attrs {
  pain_regions: string[];
  quality: "throbbing" | "pressing" | null;
  aggravated_by_activity: boolean | null;
  nausea: boolean | null;
  photophobia: boolean | null;
  phonophobia: boolean | null;
  aura: boolean | null;
}

export const emptyAttrs = (): Attrs => ({
  pain_regions: [],
  quality: null,
  aggravated_by_activity: null,
  nausea: null,
  photophobia: null,
  phonophobia: null,
  aura: null,
});

/** True when nothing at all was recorded, so callers can send null-ish and skip. */
export const attrsEmpty = (a: Attrs): boolean =>
  a.pain_regions.length === 0 &&
  a.quality === null &&
  a.aggravated_by_activity === null &&
  a.nausea === null &&
  a.photophobia === null &&
  a.phonophobia === null &&
  a.aura === null;

type BoolKey = "aggravated_by_activity" | "nausea" | "photophobia" | "phonophobia" | "aura";

const SYMPTOMS: { key: BoolKey; label: string; no: string }[] = [
  { key: "nausea", label: "Nausea", no: "No nausea" },
  { key: "photophobia", label: "Light hurt", no: "Light was fine" },
  { key: "phonophobia", label: "Sound hurt", no: "Sound was fine" },
  { key: "aggravated_by_activity", label: "Worse moving", no: "Moving was fine" },
  { key: "aura", label: "Aura", no: "No aura" },
];

/** Unrecorded -> yes -> no -> unrecorded. */
export const nextTri = (v: boolean | null): boolean | null =>
  v === null ? true : v === true ? false : null;

const chipBase =
  "flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm transition active:scale-95";

function TriChip({
  label,
  noLabel,
  value,
  onChange,
}: {
  label: string;
  noLabel: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const state = value === null ? "not recorded" : value ? "yes" : "no";
  return (
    <button
      onClick={() => onChange(nextTri(value))}
      aria-label={`${label}: ${state}`}
      className={`${chipBase} ${
        value === true
          ? "border-accent-400 bg-accent-500 text-white"
          : value === false
            ? "border-zinc-700 bg-zinc-900 text-zinc-500"
            : "border-zinc-700 bg-zinc-800 text-zinc-300"
      }`}
    >
      <span aria-hidden className="w-3 text-center text-xs">
        {value === true ? "✓" : value === false ? "✕" : "+"}
      </span>
      {value === false ? noLabel : label}
    </button>
  );
}

function QualityChip({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`${chipBase} ${
        on ? "border-accent-400 bg-accent-500 text-white" : "border-zinc-700 bg-zinc-800 text-zinc-300"
      }`}
    >
      {label}
    </button>
  );
}

export default function SymptomDetails({
  value,
  onChange,
}: {
  value: Attrs;
  onChange: (a: Attrs) => void;
}) {
  const set = <K extends keyof Attrs>(k: K, v: Attrs[K]) => onChange({ ...value, [k]: v });
  const setQuality = (q: "throbbing" | "pressing") =>
    set("quality", value.quality === q ? null : q);

  return (
    <div>
      <HeadMap value={value.pain_regions} onChange={(ids) => set("pain_regions", ids)} />

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Pain quality">
        <QualityChip label="Throbbing" on={value.quality === "throbbing"} onClick={() => setQuality("throbbing")} />
        <QualityChip label="Pressing" on={value.quality === "pressing"} onClick={() => setQuality("pressing")} />
      </div>

      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Symptoms">
        {SYMPTOMS.map((s) => (
          <TriChip
            key={s.key}
            label={s.label}
            noLabel={s.no}
            value={value[s.key]}
            onChange={(v) => set(s.key, v)}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">
        Tap once for yes, twice for no. Untouched means not recorded.
      </p>
    </div>
  );
}

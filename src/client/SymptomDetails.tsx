// F18: the optional post-attack ICHD-3 attribute panel.
//
// Every field is tri-state: yes, no, or unrecorded. "Unrecorded" is the default and
// is preserved as null, because the classifier treats a missing answer as unknown,
// never as a no. Nothing here is required; a skipped panel just leaves an attack
// counted as a headache day, not a migraine day.
//
// Layout: one compact row per question, the question on the left and explicit
// answers on the right. Tapping the chosen answer again clears it. (A single
// cycling chip was tried: tap once for yes, twice for no. It was compact but not
// obvious, so each answer is its own button again, just on one line.)

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

const QUESTIONS: { key: BoolKey; label: string }[] = [
  { key: "nausea", label: "Nausea" },
  { key: "photophobia", label: "Light bothered you" },
  { key: "phonophobia", label: "Sound bothered you" },
  { key: "aggravated_by_activity", label: "Worse when moving" },
  { key: "aura", label: "Aura beforehand" },
];

function Choice<T>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { label: string; val: T }[];
  onChange: (v: T | null) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-zinc-300">{label}</span>
      <div className="flex shrink-0 gap-1.5" role="group" aria-label={label}>
        {options.map((o) => {
          const on = value === o.val;
          return (
            <button
              key={String(o.val)}
              // Tapping the active choice again clears it back to unrecorded.
              onClick={() => onChange(on ? null : o.val)}
              aria-pressed={on}
              className={`flex min-h-11 min-w-14 items-center justify-center rounded-lg px-3 text-sm transition active:scale-95 ${
                on ? "bg-accent-500 text-white" : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const YES_NO = [
  { label: "Yes", val: true },
  { label: "No", val: false },
];

/** The where: the head map on its own, so the sheet can give it its own card. */
export function WhereItHurt({ value, onChange }: { value: Attrs; onChange: (a: Attrs) => void }) {
  return (
    <HeadMap
      value={value.pain_regions}
      onChange={(ids) => onChange({ ...value, pain_regions: ids })}
    />
  );
}

/** The what: pain quality and the yes/no questions. */
export function Symptoms({ value, onChange }: { value: Attrs; onChange: (a: Attrs) => void }) {
  const set = <K extends keyof Attrs>(k: K, v: Attrs[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-col divide-y divide-zinc-800/80">
      <Choice
        label="The pain was"
        value={value.quality}
        options={[
          { label: "Throbbing", val: "throbbing" as const },
          { label: "Pressing", val: "pressing" as const },
        ]}
        onChange={(v) => set("quality", v)}
      />
      {QUESTIONS.map((q) => (
        <Choice
          key={q.key}
          label={q.label}
          value={value[q.key]}
          options={YES_NO}
          onChange={(v) => set(q.key, v)}
        />
      ))}
    </div>
  );
}

/** Both together, for callers that want the whole panel in one place. */
export default function SymptomDetails({
  value,
  onChange,
}: {
  value: Attrs;
  onChange: (a: Attrs) => void;
}) {
  return (
    <div>
      <WhereItHurt value={value} onChange={onChange} />
      <div className="mt-3">
        <Symptoms value={value} onChange={onChange} />
      </div>
    </div>
  );
}

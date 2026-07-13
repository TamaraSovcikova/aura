// F18: the optional post-attack ICHD-3 attribute panel.
//
// Every field is tri-state: yes, no, or unrecorded. "Unrecorded" is the default and
// is preserved as null, because the classifier treats a missing answer as unknown,
// never as a no. Nothing here is required; a skipped panel just leaves an attack
// counted as a headache day, not a migraine day.

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

function TriToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T | boolean | null;
  options: { label: string; val: T | boolean }[];
  onChange: (v: T | boolean | null) => void;
}) {
  return (
    <div className="flex gap-2">
      {options.map((o) => {
        const on = value === o.val;
        return (
          <button
            key={String(o.val)}
            // Tapping the active choice again clears it back to unrecorded.
            onClick={() => onChange(on ? null : o.val)}
            className={`flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm transition ${
              on ? "bg-indigo-500 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">{label}</p>
      {children}
    </div>
  );
}

const yesNo = [
  { label: "Yes", val: true },
  { label: "No", val: false },
];

export default function SymptomDetails({
  value,
  onChange,
}: {
  value: Attrs;
  onChange: (a: Attrs) => void;
}) {
  const set = <K extends keyof Attrs>(k: K, v: Attrs[K]) => onChange({ ...value, [k]: v });

  return (
    <div>
      <HeadMap value={value.pain_regions} onChange={(ids) => set("pain_regions", ids)} />

      <Row label="Pain quality">
        <TriToggle
          value={value.quality}
          options={[
            { label: "Throbbing", val: "throbbing" },
            { label: "Pressing", val: "pressing" },
          ]}
          onChange={(v) => set("quality", v as Attrs["quality"])}
        />
      </Row>

      <Row label="Worse with activity">
        <TriToggle value={value.aggravated_by_activity} options={yesNo} onChange={(v) => set("aggravated_by_activity", v as boolean)} />
      </Row>
      <Row label="Nausea">
        <TriToggle value={value.nausea} options={yesNo} onChange={(v) => set("nausea", v as boolean)} />
      </Row>
      <Row label="Light bothered you">
        <TriToggle value={value.photophobia} options={yesNo} onChange={(v) => set("photophobia", v as boolean)} />
      </Row>
      <Row label="Sound bothered you">
        <TriToggle value={value.phonophobia} options={yesNo} onChange={(v) => set("phonophobia", v as boolean)} />
      </Row>
      <Row label="Aura (visual / sensory warning)">
        <TriToggle value={value.aura} options={yesNo} onChange={(v) => set("aura", v as boolean)} />
      </Row>
    </div>
  );
}

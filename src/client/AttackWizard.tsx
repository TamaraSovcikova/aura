import { useEffect, useRef, useState } from "react";
import { SEVERITY_MAX, SEVERITY_MIN, SEVERITY_QUICK } from "../shared/types";
import { HEAD_REGIONS } from "../shared/headmap";
import { DoseSection, TimeEditor, type AttackDraft, type DoseView } from "./AttackSheet";
import HeadMap from "./HeadMap";
import { severityWord } from "./SeverityInput";
import type { Attrs } from "./SymptomDetails";
import VoiceNoteField from "./VoiceNoteField";
import { attackTimes, clockHM, dayClock } from "./time";

// The "How was it?" walkthrough, shown when an attack has just ended.
//
// The single long form asked everything at once, which is overwhelming mid-recovery
// and made it easy to skip the lot. This asks one thing per page, in the order that
// is easiest to answer: how bad, where, how it felt, what came with it, what was
// taken, anything else, then a review with the times.
//
// Rules:
//   * Every page can be skipped. The attack itself is already saved; nothing here
//     is required, and "Save and finish" works from any page.
//   * Anything a person may not remember offers an explicit "Not sure". It is
//     stored as unknown (null), exactly like an unanswered question, because the
//     ICHD-3 classifier must never read "not sure" as "no". The UI remembers the
//     choice only so the button stays lit.
//   * A single-answer page moves on by itself once answered; pages with several
//     answers wait for Next.
//
// Editing an old attack later keeps the one-page AttackSheet, where jumping to a
// single field matters more than being walked through.

type BoolKey = "nausea" | "photophobia" | "phonophobia" | "aggravated_by_activity" | "aura";
type Tri = boolean | null;

const QUESTIONS: { key: BoolKey; label: string }[] = [
  { key: "nausea", label: "Nausea" },
  { key: "photophobia", label: "Light bothered you" },
  { key: "phonophobia", label: "Sound bothered you" },
  { key: "aggravated_by_activity", label: "Worse when moving" },
  { key: "aura", label: "Aura beforehand" },
];

const STEPS = ["severity", "where", "quality", "symptoms", "meds", "note", "review"] as const;
type Step = (typeof STEPS)[number];

const TITLES: Record<Step, string> = {
  severity: "How bad was it at its worst?",
  where: "Where did it hurt?",
  quality: "How did the pain feel?",
  symptoms: "Did anything come with it?",
  meds: "Did you take anything for it?",
  note: "Anything else to remember?",
  review: "Check and save",
};

const AUTO_ADVANCE_MS = 280;

function Option({
  on,
  onClick,
  children,
  muted,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`flex min-h-12 w-full items-center justify-center rounded-xl px-4 text-base transition active:scale-[0.98] ${
        on
          ? "bg-accent-500 text-white"
          : muted
            ? "border border-zinc-700 bg-transparent text-zinc-400"
            : "bg-zinc-800 text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

/** One yes / no / not sure row. "Not sure" is null, like unanswered. */
function TriRow({
  label,
  value,
  unsure,
  onChange,
}: {
  label: string;
  value: Tri;
  unsure: boolean;
  onChange: (v: Tri, unsure: boolean) => void;
}) {
  const btn = (text: string, on: boolean, next: () => void) => (
    <button
      onClick={next}
      aria-pressed={on}
      className={`flex min-h-11 flex-1 items-center justify-center rounded-lg px-2 text-sm transition active:scale-95 ${
        on ? "bg-accent-500 text-white" : "bg-zinc-800 text-zinc-400"
      }`}
    >
      {text}
    </button>
  );
  return (
    <div className="py-2">
      <p className="mb-1.5 text-sm text-zinc-200">{label}</p>
      <div className="flex gap-1.5" role="group" aria-label={label}>
        {btn("Yes", value === true, () => onChange(value === true ? null : true, false))}
        {btn("No", value === false, () => onChange(value === false ? null : false, false))}
        {btn("Not sure", unsure, () => onChange(null, !unsure))}
      </div>
    </div>
  );
}

export default function AttackWizard({
  initial,
  doses,
  legacyMeds = null,
  onSave,
  onCancel,
  onAddDose,
  onLogRelief,
  onDeleteDose,
}: {
  initial: AttackDraft;
  doses: DoseView[];
  legacyMeds?: string | null;
  onSave: (d: AttackDraft) => void;
  onCancel: () => void;
  onAddDose: (name: string | null, takenAt: string) => void;
  onLogRelief: (key: string, reliefAt: string, residual: number | null) => void;
  onDeleteDose: (key: string) => void;
}) {
  const [i, setI] = useState(0);
  const [startedAt, setStartedAt] = useState(initial.started_at);
  const [timeKnown, setTimeKnown] = useState(initial.started_at_time_known);
  const [endedAt, setEndedAt] = useState<string | null>(initial.ended_at);
  const [severity, setSeverity] = useState<number | null>(initial.severity);
  const [note, setNote] = useState(initial.note);
  const [attrs, setAttrs] = useState<Attrs>(initial.attrs);
  const [editingTime, setEditingTime] = useState<"start" | "end" | null>(null);
  // "Not sure" answers, remembered only so their buttons stay lit (the data is null).
  const [unsure, setUnsure] = useState<Set<string>>(new Set());
  // Medication: "yes" opens the dose logger; no / don't remember record nothing.
  const [tookMeds, setTookMeds] = useState<"yes" | "no" | "unsure" | null>(
    doses.length ? "yes" : null
  );

  const step = STEPS[i];
  const advanceTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
  }, []);

  const go = (to: number) => {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
    setI(Math.max(0, Math.min(STEPS.length - 1, to)));
  };
  const next = () => go(i + 1);
  const nextSoon = () => {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => setI((x) => Math.min(STEPS.length - 1, x + 1)), AUTO_ADVANCE_MS);
  };

  const markUnsure = (key: string, on: boolean) =>
    setUnsure((s) => {
      const n = new Set(s);
      on ? n.add(key) : n.delete(key);
      return n;
    });

  const endBeforeStart = endedAt !== null && endedAt < startedAt;
  const draft = (): AttackDraft => ({
    started_at: startedAt,
    started_at_time_known: timeKnown,
    ended_at: endedAt,
    severity,
    note,
    attrs,
  });
  const finish = () => {
    if (!endBeforeStart) onSave(draft());
  };

  // Whether the current page has an answer (including an explicit "not sure"), so
  // the forward button can say Skip or Next.
  const hasAnswer: Record<Step, boolean> = {
    severity: severity !== null || unsure.has("severity"),
    where: attrs.pain_regions.length > 0 || unsure.has("where"),
    quality: attrs.quality !== null || unsure.has("quality"),
    symptoms: QUESTIONS.some((q) => attrs[q.key] !== null || unsure.has(q.key)),
    meds: tookMeds !== null,
    note: note.trim().length > 0,
    review: true,
  };

  const t = attackTimes({ started_at: startedAt, ended_at: endedAt, started_at_time_known: timeKnown, source: "app" });
  const regionLabels = attrs.pain_regions
    .map((id) => HEAD_REGIONS.find((r) => r.id === id)?.label ?? id)
    .join(", ");
  const answered = (v: Tri, key: string) => (v === true ? "yes" : v === false ? "no" : unsure.has(key) ? "not sure" : "skipped");

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 sm:items-center sm:p-6">
      <div className="flex max-h-[92vh] min-h-[70vh] w-full max-w-md flex-col rounded-t-3xl bg-zinc-900 sm:rounded-3xl">
        {/* Header: progress, back, close. */}
        <div className="px-5 pt-4">
          <div className="flex items-center justify-between">
            <button
              onClick={() => go(i - 1)}
              disabled={i === 0}
              className="flex min-h-11 min-w-11 items-center text-sm text-zinc-400 disabled:invisible"
            >
              ← Back
            </button>
            <span className="text-xs tabular-nums text-zinc-500">
              {i + 1} of {STEPS.length}
            </span>
            <button
              // Closing keeps whatever was answered: several pages in, throwing the
              // answers away would be the surprising outcome. With nothing answered
              // it is the same as skipping.
              onClick={() => (endBeforeStart ? onCancel() : finish())}
              className="flex min-h-11 min-w-11 items-center justify-end text-sm text-zinc-400"
            >
              Close
            </button>
          </div>
          <div className="mt-1 flex gap-1" aria-hidden>
            {STEPS.map((s, n) => (
              <span key={s} className={`h-1 flex-1 rounded-full ${n <= i ? "bg-accent-400" : "bg-zinc-800"}`} />
            ))}
          </div>
          {i === 0 && (
            <p className="mt-3 text-xs text-zinc-400">
              The attack is saved ({t.duration ?? "ongoing"}). These questions are optional; skip any you are unsure of.
            </p>
          )}
          <h3 className="mt-4 text-xl font-semibold text-zinc-100">{TITLES[step]}</h3>
        </div>

        {/* The page. */}
        <div className="flex-1 overflow-y-auto px-5 pb-4 pt-4">
          {step === "severity" && (
            <div className="flex flex-col gap-2">
              {SEVERITY_QUICK.map((q) => (
                <Option
                  key={q.level}
                  on={severity === q.level}
                  onClick={() => {
                    setSeverity(q.level);
                    markUnsure("severity", false);
                    nextSoon();
                  }}
                >
                  {q.label} <span className="ml-2 text-sm opacity-70">{q.level}/{SEVERITY_MAX}</span>
                </Option>
              ))}
              <div className="mt-3 rounded-xl bg-zinc-800/50 p-3">
                <div className="flex items-baseline justify-between text-sm text-zinc-400">
                  <span>Or the exact number</span>
                  <span>
                    {severity === null ? (
                      "–"
                    ) : (
                      <>
                        <span className="text-xl font-semibold text-zinc-100">{severity}</span>/{SEVERITY_MAX}{" "}
                        {severityWord(severity)}
                      </>
                    )}
                  </span>
                </div>
                <input
                  type="range"
                  min={SEVERITY_MIN}
                  max={SEVERITY_MAX}
                  value={severity ?? 0}
                  onChange={(e) => {
                    setSeverity(Number(e.target.value));
                    markUnsure("severity", false);
                  }}
                  aria-label="Exact severity"
                  className={`mt-2 w-full accent-accent-500 ${severity === null ? "opacity-50" : ""}`}
                />
              </div>
              <div className="mt-2">
                <Option
                  muted
                  on={unsure.has("severity")}
                  onClick={() => {
                    setSeverity(null);
                    markUnsure("severity", true);
                    nextSoon();
                  }}
                >
                  Not sure
                </Option>
              </div>
            </div>
          )}

          {step === "where" && (
            <div>
              <p className="-mt-2 mb-3 text-sm text-zinc-400">Tap every area that hurt. Tap again to undo.</p>
              <HeadMap
                value={attrs.pain_regions}
                onChange={(ids) => {
                  setAttrs({ ...attrs, pain_regions: ids });
                  if (ids.length) markUnsure("where", false);
                }}
              />
              <div className="mt-4">
                <Option
                  muted
                  on={unsure.has("where")}
                  onClick={() => {
                    setAttrs({ ...attrs, pain_regions: [] });
                    markUnsure("where", true);
                    nextSoon();
                  }}
                >
                  Couldn't tell
                </Option>
              </div>
            </div>
          )}

          {step === "quality" && (
            <div className="flex flex-col gap-2">
              <Option
                on={attrs.quality === "throbbing"}
                onClick={() => {
                  setAttrs({ ...attrs, quality: "throbbing" });
                  markUnsure("quality", false);
                  nextSoon();
                }}
              >
                Throbbing or pulsing
              </Option>
              <Option
                on={attrs.quality === "pressing"}
                onClick={() => {
                  setAttrs({ ...attrs, quality: "pressing" });
                  markUnsure("quality", false);
                  nextSoon();
                }}
              >
                Pressing or tight
              </Option>
              <div className="mt-2">
                <Option
                  muted
                  on={unsure.has("quality")}
                  onClick={() => {
                    setAttrs({ ...attrs, quality: null });
                    markUnsure("quality", true);
                    nextSoon();
                  }}
                >
                  Not sure
                </Option>
              </div>
            </div>
          )}

          {step === "symptoms" && (
            <div className="divide-y divide-zinc-800/80">
              {QUESTIONS.map((q) => (
                <TriRow
                  key={q.key}
                  label={q.label}
                  value={attrs[q.key]}
                  unsure={unsure.has(q.key)}
                  onChange={(v, isUnsure) => {
                    setAttrs({ ...attrs, [q.key]: v });
                    markUnsure(q.key, isUnsure);
                  }}
                />
              ))}
            </div>
          )}

          {step === "meds" && (
            <div className="flex flex-col gap-2">
              <Option on={tookMeds === "yes"} onClick={() => setTookMeds("yes")}>
                Yes
              </Option>
              {tookMeds === "yes" && (
                <div className="rounded-xl bg-zinc-800/40 p-3">
                  <DoseSection
                    doses={doses}
                    legacyMeds={legacyMeds}
                    onAddDose={onAddDose}
                    onLogRelief={onLogRelief}
                    onDeleteDose={onDeleteDose}
                  />
                </div>
              )}
              <Option
                on={tookMeds === "no"}
                onClick={() => {
                  setTookMeds("no");
                  nextSoon();
                }}
              >
                No
              </Option>
              <Option
                muted
                on={tookMeds === "unsure"}
                onClick={() => {
                  setTookMeds("unsure");
                  nextSoon();
                }}
              >
                Don't remember
              </Option>
            </div>
          )}

          {step === "note" && <VoiceNoteField value={note} onChange={setNote} />}

          {step === "review" && (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl bg-zinc-800/50 p-3">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-zinc-400">Started</span>
                  <button className="min-h-11 tabular-nums text-zinc-100 underline decoration-zinc-600 underline-offset-4" onClick={() => setEditingTime((e) => (e === "start" ? null : "start"))}>
                    {timeKnown ? dayClock(startedAt) : `~${dayClock(startedAt)}`}
                  </button>
                </div>
                {editingTime === "start" && (
                  <TimeEditor label="Started" value={startedAt} onChange={(iso) => iso && setStartedAt(iso)} known={timeKnown} onKnownChange={setTimeKnown} allowRelative />
                )}
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-zinc-400">Ended</span>
                  <button className="min-h-11 tabular-nums text-zinc-100 underline decoration-zinc-600 underline-offset-4" onClick={() => setEditingTime((e) => (e === "end" ? null : "end"))}>
                    {endedAt ? clockHM(endedAt) : "ongoing"}
                  </button>
                </div>
                {editingTime === "end" && <TimeEditor label="Ended" value={endedAt} onChange={setEndedAt} allowRelative />}
                {endBeforeStart && <p className="text-xs text-rose-400">The end is before the start.</p>}
                <p className="mt-1 text-[11px] text-zinc-500">Tap a time to correct it.</p>
              </div>

              <ul className="divide-y divide-zinc-800 rounded-xl bg-zinc-800/50 text-sm">
                {[
                  { label: "Worst", value: severity === null ? (unsure.has("severity") ? "not sure" : "skipped") : `${severity}/${SEVERITY_MAX} ${severityWord(severity)}`, to: 0 },
                  { label: "Where", value: regionLabels || (unsure.has("where") ? "couldn't tell" : "skipped"), to: 1 },
                  { label: "Felt", value: attrs.quality ?? (unsure.has("quality") ? "not sure" : "skipped"), to: 2 },
                  ...QUESTIONS.map((q) => ({ label: q.label, value: answered(attrs[q.key], q.key), to: 3 })),
                  { label: "Medication", value: doses.length ? `${doses.length} ${doses.length === 1 ? "dose" : "doses"}` : tookMeds === "no" ? "none" : tookMeds === "unsure" ? "don't remember" : "skipped", to: 4 },
                  { label: "Note", value: note.trim() ? `“${note.trim().slice(0, 40)}${note.trim().length > 40 ? "…" : ""}”` : "none", to: 5 },
                ].map((r) => (
                  <li key={r.label}>
                    <button onClick={() => go(r.to)} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left">
                      <span className="text-zinc-400">{r.label}</span>
                      <span className={`text-right ${r.value === "skipped" ? "text-zinc-600" : "text-zinc-200"}`}>{r.value}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Footer: skip / next, or save. */}
        <div className="flex items-center gap-3 border-t border-zinc-800 px-5 pb-5 pt-3">
          {step === "review" ? (
            <button
              onClick={finish}
              disabled={endBeforeStart}
              className="min-h-12 flex-1 rounded-xl bg-accent-500 text-base font-medium text-white disabled:opacity-40"
            >
              Save
            </button>
          ) : (
            <>
              <button onClick={finish} className="min-h-12 rounded-xl px-3 text-sm text-zinc-400">
                Save and finish
              </button>
              <button
                onClick={next}
                className="ml-auto min-h-12 rounded-xl bg-zinc-800 px-6 text-base text-zinc-100"
              >
                {step === "note" ? "Review" : hasAnswer[step] ? "Next" : "Skip"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

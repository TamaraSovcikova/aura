import { useState } from "react";
import SeverityInput from "./SeverityInput";
import SymptomDetails, { type Attrs } from "./SymptomDetails";
import VoiceNoteField from "./VoiceNoteField";
import {
  attackTimes,
  clockHM,
  dayClock,
  isoToLocalInput,
  localInputToIso,
  minusMinutes,
  nowIso,
} from "./time";

// ONE sheet for an attack's detail, used both when it has just ended and when it is
// edited later from the log.
//
// Before this there were two near-identical modals that diverged for no reason: the
// end sheet set times with relative offsets and kept symptoms collapsed, the edit
// sheet used datetime inputs and kept them open, and both asked for medication as
// free text while the dose button recorded it structurally somewhere else. Same
// data, two layouts, two stores.
//
// The rules here:
//   * One field order, both modes: when -> how bad -> medication -> note -> symptoms.
//   * One time editor. It always offers an absolute time; relative "N ago" chips are
//     an affordance the caller enables when the attack is near now, not a separate UI.
//   * Medication is the structured dose. The legacy free-text field is shown when a
//     record still carries one, so nothing is lost, but nothing new is written to it.

export interface DoseView {
  /** Stable key: the outbox localId before sync, the server id after. */
  key: string;
  name: string | null;
  taken_at: string;
  relief_at: string | null;
  relief_severity: number | null;
}

export interface AttackDraft {
  started_at: string;
  started_at_time_known: boolean;
  ended_at: string | null;
  severity: number | null;
  note: string;
  attrs: Attrs;
}

const QUICK_AGO = [
  { label: "now", min: 0 },
  { label: "30m ago", min: 30 },
  { label: "1h ago", min: 60 },
  { label: "2h ago", min: 120 },
];

/**
 * The one time editor. Collapsed it shows the value; expanded it offers an absolute
 * datetime, plus quick "N ago" chips when the time being set is near now.
 */
function TimeField({
  label,
  value,
  onChange,
  known,
  onKnownChange,
  allowRelative,
  emptyLabel,
  error,
}: {
  label: string;
  value: string | null;
  onChange: (iso: string | null) => void;
  known?: boolean;
  onKnownChange?: (k: boolean) => void;
  allowRelative: boolean;
  emptyLabel?: string;
  error?: string;
}) {
  const [open, setOpen] = useState(false);

  const shown = value
    ? known === false
      ? `~${dayClock(value)}`
      : dayClock(value)
    : (emptyLabel ?? "not set");

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-zinc-400 underline underline-offset-2"
        >
          {open ? "done" : "change"}
        </button>
      </div>
      <p className="text-sm tabular-nums text-zinc-200">{shown}</p>

      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-zinc-800/60 p-2.5">
          {allowRelative && (
            <div className="flex gap-1.5">
              {QUICK_AGO.map((q) => (
                <button
                  key={q.min}
                  onClick={() => onChange(minusMinutes(nowIso(), q.min))}
                  className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-zinc-800 text-xs text-zinc-300 transition active:scale-95"
                >
                  {q.label}
                </button>
              ))}
            </div>
          )}
          <input
            type="datetime-local"
            value={value ? isoToLocalInput(value) : ""}
            onChange={(e) => onChange(e.target.value ? localInputToIso(e.target.value) : null)}
            aria-label={label}
            className="min-h-11 w-full rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100 outline-none"
          />
          {onKnownChange && (
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={known !== false}
                onChange={(e) => onKnownChange(e.target.checked)}
                className="accent-accent-500"
              />
              I know the time it started (uncheck if it woke you or you noticed late)
            </label>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
    </div>
  );
}

/** Medication: the doses themselves, addable and correctable at any time. */
function DoseSection({
  doses,
  legacyMeds,
  onAddDose,
  onLogRelief,
  onDeleteDose,
}: {
  doses: DoseView[];
  legacyMeds: string | null;
  onAddDose: (name: string | null, takenAt: string) => void;
  onLogRelief: (key: string, reliefAt: string, residual: number | null) => void;
  onDeleteDose: (key: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(
    () => (typeof localStorage === "undefined" ? "" : localStorage.getItem("aura_last_med") ?? "")
  );
  const [takenAt, setTakenAt] = useState(() => isoToLocalInput(nowIso()));
  const [relieving, setRelieving] = useState<string | null>(null);
  const [residual, setResidual] = useState<number | null>(0);

  const add = () => {
    const iso = localInputToIso(takenAt);
    if (!iso) return;
    const n = name.trim();
    if (n) localStorage.setItem("aura_last_med", n);
    onAddDose(n || null, iso);
    setAdding(false);
  };

  return (
    <div className="mt-5">
      <p className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Medication</p>

      {doses.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1.5">
          {doses.map((d) => (
            <li key={d.key} className="rounded-lg bg-zinc-800/60 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-zinc-200">
                  {d.name || "Medication"} · {clockHM(d.taken_at)}
                </span>
                <button
                  onClick={() => onDeleteDose(d.key)}
                  aria-label="Remove dose"
                  className="text-xs text-zinc-500 underline"
                >
                  remove
                </button>
              </div>
              {d.relief_at ? (
                <p className="mt-0.5 text-xs text-zinc-400">
                  Felt better {clockHM(d.relief_at)}
                  {d.relief_severity != null ? ` · down to ${d.relief_severity}/10` : ""}
                </p>
              ) : relieving === d.key ? (
                <div className="mt-2 flex flex-col gap-2">
                  <SeverityInput
                    value={residual}
                    onChange={setResidual}
                    label="Pain after this dose"
                    hint="0 means it was gone."
                  />
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => {
                        onLogRelief(d.key, nowIso(), residual);
                        setRelieving(null);
                        setResidual(0);
                      }}
                      className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-accent-500 text-sm text-white"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setRelieving(null)}
                      className="flex min-h-11 items-center rounded-lg bg-zinc-800 px-3 text-xs text-zinc-400"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setRelieving(d.key)}
                  className="mt-1 flex min-h-11 items-center text-xs text-accent-300 underline underline-offset-2"
                >
                  It helped
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-800/60 p-2.5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What did you take? (optional)"
            aria-label="Medication name"
            autoFocus
            className="min-h-11 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <input
            type="datetime-local"
            value={takenAt}
            onChange={(e) => setTakenAt(e.target.value)}
            aria-label="Time taken"
            className="min-h-11 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100 outline-none"
          />
          <div className="flex gap-1.5">
            <button
              onClick={add}
              className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-accent-500 text-sm text-white"
            >
              Add dose
            </button>
            <button
              onClick={() => setAdding(false)}
              className="flex min-h-11 items-center rounded-lg bg-zinc-800 px-3 text-xs text-zinc-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => {
            setTakenAt(isoToLocalInput(nowIso()));
            setAdding(true);
          }}
          className="flex min-h-11 w-full items-center justify-center rounded-lg bg-zinc-800 text-sm text-zinc-200 transition active:scale-95"
        >
          {doses.length ? "Add another dose" : "Add a dose"}
        </button>
      )}

      {legacyMeds && (
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          Recorded earlier as free text: “{legacyMeds}”. Kept as written; new doses are
          logged above.
        </p>
      )}
    </div>
  );
}

export default function AttackSheet({
  title,
  initial,
  doses,
  legacyMeds = null,
  allowRelative,
  saveLabel = "Save",
  cancelLabel = "Cancel",
  onSave,
  onCancel,
  onDelete,
  onAddDose,
  onLogRelief,
  onDeleteDose,
}: {
  title: string;
  initial: AttackDraft;
  doses: DoseView[];
  legacyMeds?: string | null;
  /** Enables the "N ago" chips: true when the attack is happening around now. */
  allowRelative: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  onSave: (d: AttackDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onAddDose: (name: string | null, takenAt: string) => void;
  onLogRelief: (key: string, reliefAt: string, residual: number | null) => void;
  onDeleteDose: (key: string) => void;
}) {
  const [startedAt, setStartedAt] = useState<string>(initial.started_at);
  const [timeKnown, setTimeKnown] = useState(initial.started_at_time_known);
  const [endedAt, setEndedAt] = useState<string | null>(initial.ended_at);
  const [severity, setSeverity] = useState<number | null>(initial.severity);
  const [note, setNote] = useState(initial.note);
  const [attrs, setAttrs] = useState<Attrs>(initial.attrs);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const endBeforeStart = endedAt !== null && endedAt < startedAt;
  const canSave = !endBeforeStart;
  const t = attackTimes({
    started_at: startedAt,
    ended_at: endedAt,
    started_at_time_known: timeKnown,
    source: "app",
  });

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-zinc-900 p-6 sm:rounded-2xl">
        <div className="flex items-baseline justify-between">
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          <span className="text-xs tabular-nums text-zinc-400">
            {t.duration ?? t.end}
          </span>
        </div>

        <TimeField
          label="Started"
          value={startedAt}
          onChange={(iso) => iso && setStartedAt(iso)}
          known={timeKnown}
          onKnownChange={setTimeKnown}
          allowRelative={allowRelative}
        />

        <TimeField
          label="Ended"
          value={endedAt}
          onChange={setEndedAt}
          allowRelative={allowRelative}
          emptyLabel="ongoing"
          error={endBeforeStart ? "The end is before the start." : undefined}
        />

        <div className="mt-5">
          <SeverityInput
            value={severity}
            onChange={setSeverity}
            label="How bad at its worst"
          />
        </div>

        <DoseSection
          doses={doses}
          legacyMeds={legacyMeds}
          onAddDose={onAddDose}
          onLogRelief={onLogRelief}
          onDeleteDose={onDeleteDose}
        />

        <VoiceNoteField value={note} onChange={setNote} />

        <p className="mt-5 mb-1 text-xs uppercase tracking-wide text-zinc-400">Symptoms</p>
        <SymptomDetails value={attrs} onChange={setAttrs} />

        {confirmDelete ? (
          <div className="mt-6 rounded-lg bg-rose-950/40 p-3">
            <p className="text-sm text-rose-200">Delete this entry for good?</p>
            <div className="mt-3 flex gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="min-h-11 flex-1 rounded-lg bg-zinc-800 py-2 text-sm text-zinc-300"
              >
                Keep
              </button>
              <button
                onClick={onDelete}
                className="min-h-11 flex-1 rounded-lg bg-rose-600 py-2 text-sm font-medium text-white"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex items-center gap-3">
            {onDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg px-3 py-3 text-sm text-rose-400"
              >
                Delete
              </button>
            )}
            <button
              onClick={onCancel}
              className="ml-auto rounded-lg bg-zinc-800 px-5 py-3 text-sm text-zinc-300"
            >
              {cancelLabel}
            </button>
            <button
              onClick={() =>
                onSave({
                  started_at: startedAt,
                  started_at_time_known: timeKnown,
                  ended_at: endedAt,
                  severity,
                  note,
                  attrs,
                })
              }
              disabled={!canSave}
              className="rounded-lg bg-accent-500 px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
            >
              {saveLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

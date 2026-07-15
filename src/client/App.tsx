import { useCallback, useEffect, useRef, useState } from "react";
import {
  SEVERITY_MAX,
  SEVERITY_MIN,
  SEVERITY_QUICK,
  type Episode,
} from "../shared/types";
import { durationMs, formatDuration } from "../shared/format";
import {
  apiCurrent,
  apiDelete,
  apiEnd,
  apiList,
  apiLogDose,
  apiLogRelief,
  apiPatch,
  apiPremonition,
  apiStart,
  hasPin,
  setPin,
  UnauthorizedError,
} from "./api";
import {
  findOpen,
  loadOutbox,
  newLocalDose,
  newLocalEpisode,
  reconcile,
  saveOutbox,
  type LocalEpisode,
  type DoseFn,
  type EndFn,
  type ReliefFn,
  type StartFn,
} from "./outbox";
import { currentTz, getCoords } from "./geo";
import { clockHM, isoToLocalInput, localInputToIso, minusMinutes, nowIso } from "./time";
import SymptomDetails, { type Attrs, emptyAttrs, attrsEmpty } from "./SymptomDetails";
import { parseRegions } from "../shared/headmap";
import Insights from "./Insights";
import { appendTranscript, listen, supportsVoice } from "./voice";
import {
  loadPremOutbox,
  newPremonition,
  reconcilePremonitions,
  savePremOutbox,
} from "./premonitions";

const startFn: StartFn = async (e) => {
  const ep = await apiStart({
    client_started_at: e.started_at,
    started_at_time_known: e.time_known,
    lat: e.lat ?? undefined,
    lon: e.lon ?? undefined,
    tz: e.tz ?? undefined,
  });
  return ep.id;
};

const endFn: EndFn = async (serverId, body) => {
  await apiEnd(serverId, body);
};

const doseFn: DoseFn = async (episodeServerId, body) => apiLogDose(episodeServerId, body);
const reliefFn: ReliefFn = async (doseServerId, body) => apiLogRelief(doseServerId, body);

const sendPremFn = async (p: {
  felt_at: string;
  lat: number | null;
  lon: number | null;
  tz: string | null;
}) => {
  await apiPremonition({
    client_felt_at: p.felt_at,
    lat: p.lat ?? undefined,
    lon: p.lon ?? undefined,
    tz: p.tz ?? undefined,
  });
};

function pendingCount(list: LocalEpisode[]): number {
  return list.filter((e) => !e.startedSynced || (e.ended_at && !e.endedSynced))
    .length;
}

// A shortcut launch (?action=…) must be handled exactly once per page load. A
// module-level flag survives StrictMode's double-mount and any effect re-run within
// the same launch, and resets naturally on the next real navigation.
let deepLinkConsumed = false;

type Tab = "today" | "insights";

export default function App() {
  const [pinReady, setPinReady] = useState(hasPin());
  const [tab, setTab] = useState<Tab>("today");
  const [open, setOpen] = useState<LocalEpisode | null>(null);
  const [nowTs, setNowTs] = useState(Date.now());
  const [recent, setRecent] = useState<Episode[]>([]);
  const [endPanel, setEndPanel] = useState<LocalEpisode | null>(null);
  const [editing, setEditing] = useState<Episode | null>(null);
  const [premLoggedAt, setPremLoggedAt] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [error, setError] = useState<string | null>(null);

  // Stable so it does not change identity on every timer tick: Insights keys its
  // data-loading effect off this callback, and a fresh lambda each second would
  // make it refetch every summary/pattern/med endpoint once a second during an
  // ongoing attack (when the elapsed timer is re-rendering App).
  const handleUnauthorized = useCallback(() => setPinReady(false), []);

  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await apiList(20));
    } catch {
      /* offline: keep what we have */
    }
  }, []);

  const runSync = useCallback(async () => {
    try {
      const result = await reconcile(loadOutbox(), startFn, endFn, doseFn, reliefFn);
      saveOutbox(result);
      setOpen(findOpen(result) ?? null);
      setPending(pendingCount(result));
      setError(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setError("That PIN was rejected. Enter it again.");
        setPinReady(false);
      }
    }
  }, []);

  // Flush any premonitions queued while offline.
  const flushPremonitions = useCallback(async () => {
    try {
      savePremOutbox(await reconcilePremonitions(loadPremOutbox(), sendPremFn));
    } catch {
      /* auth errors surface through runSync */
    }
  }, []);

  // Initial load: adopt a server-side open episode if the device has none,
  // then sync anything queued and pull the recent list.
  useEffect(() => {
    if (!pinReady) return;
    let cancelled = false;
    (async () => {
      if (!findOpen(loadOutbox())) {
        try {
          const cur = await apiCurrent();
          if (cur && !cancelled) {
            const list = loadOutbox();
            list.push({
              localId: crypto.randomUUID(),
              serverId: cur.id,
              started_at: cur.started_at,
              ended_at: null,
              time_known: cur.started_at_time_known !== 0,
              lat: cur.lat,
              lon: cur.lon,
              tz: cur.tz,
              severity: cur.severity,
              meds: cur.meds,
              note: cur.note,
              attrs: null,
              doses: [],
              startedSynced: true,
              endedSynced: false,
            });
            saveOutbox(list);
          }
        } catch {
          /* offline: fine */
        }
      }
      if (cancelled) return;
      setOpen(findOpen(loadOutbox()) ?? null);
      await flushPremonitions();
      await runSync();
      await refreshRecent();
    })();
    return () => {
      cancelled = true;
    };
  }, [pinReady, runSync, refreshRecent, flushPremonitions]);

  // Clear the "logged" confirmation after a moment.
  useEffect(() => {
    if (!premLoggedAt) return;
    const t = setTimeout(() => setPremLoggedAt(null), 5000);
    return () => clearTimeout(t);
  }, [premLoggedAt]);

  // Tick the elapsed timer while an episode is open.
  useEffect(() => {
    if (!open) return;
    setNowTs(Date.now());
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  // Sync on reconnect.
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      flushPremonitions();
      runSync().then(refreshRecent);
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [runSync, refreshRecent, flushPremonitions]);

  const onStart = useCallback(async () => {
    const rec = newLocalEpisode({
      started_at: new Date().toISOString(),
      lat: null,
      lon: null,
      tz: currentTz(),
    });
    const list = loadOutbox();
    list.push(rec);
    saveOutbox(list);
    setOpen(rec); // instant, optimistic
    setPending(pendingCount(loadOutbox()));

    // Enrich with location in the background, then sync.
    const coords = await getCoords();
    if (coords) {
      const l2 = loadOutbox();
      const found = l2.find((x) => x.localId === rec.localId);
      if (found && !found.startedSynced) {
        found.lat = coords.lat;
        found.lon = coords.lon;
        saveOutbox(l2);
      }
    }
    runSync();
  }, [runSync]);

  // Backdate the open episode's start. Any adjustment is an estimate, so the time
  // is marked not-known: the date stays exact (headache-day counts stay right) but
  // the onset is held out of the premonition timing stat. `startedAt` is a UTC ISO;
  // `woke` means "present on waking, onset unknown" and keeps the current instant.
  const adjustStart = useCallback(
    // `known` is true only when she types the exact clock time she remembers; the
    // quick presets are estimates and stay time-unknown (held out of the premonition
    // timing stat).
    async (startedAt: string, known = false) => {
      const list = loadOutbox();
      const rec = findOpen(list);
      if (!rec) return;
      rec.started_at = startedAt;
      rec.time_known = known;
      saveOutbox(list);
      setOpen({ ...rec });
      // If the start already reached the server, correct it there too; otherwise
      // the corrected value simply rides the initial POST when it syncs.
      if (rec.startedSynced && rec.serverId != null) {
        try {
          await apiPatch(rec.serverId, {
            started_at: startedAt,
            started_at_time_known: known ? 1 : 0,
          });
        } catch (e) {
          if (e instanceof UnauthorizedError) {
            setError("That PIN was rejected. Enter it again.");
            setPinReady(false);
          }
        }
      }
    },
    []
  );

  // Log a medication dose against the open attack, timestamped now. Queued in the
  // episode's outbox record so it survives offline and rides out to the server once
  // the attack has a server id. `name` is optional: a fast tap need not name the pill.
  const onLogDose = useCallback(
    (name: string | null) => {
      const list = loadOutbox();
      const rec = findOpen(list);
      if (!rec) return;
      rec.doses.push(
        newLocalDose({ name: name?.trim() || null, taken_at: new Date().toISOString() })
      );
      saveOutbox(list);
      setOpen({ ...rec });
      runSync();
    },
    [runSync]
  );

  // "I feel better": stamp relief on the most recent dose that has none yet, with an
  // optional residual level (where the pain landed, 0 = gone). The dose-to-relief gap
  // is what makes time-to-effect and effectiveness derivable later.
  const onLogRelief = useCallback(
    (residual: number | null) => {
      const list = loadOutbox();
      const rec = findOpen(list);
      if (!rec) return;
      const dose = [...rec.doses].reverse().find((d) => d.relief_at == null);
      if (!dose) return;
      dose.relief_at = new Date().toISOString();
      dose.relief_severity = residual;
      saveOutbox(list);
      setOpen({ ...rec });
      runSync();
    },
    [runSync]
  );

  // "I feel one coming." One tap, timestamped instantly, never asks a follow-up.
  // Queued locally first so a dead connection cannot lose it: unlike weather,
  // a premonition can never be reconstructed after the fact.
  const onPremonition = useCallback(async () => {
    const feltAt = new Date().toISOString();
    const rec = newPremonition({
      felt_at: feltAt,
      lat: null,
      lon: null,
      tz: currentTz(),
    });
    const list = loadPremOutbox();
    list.push(rec);
    savePremOutbox(list);
    setPremLoggedAt(feltAt); // instant feedback

    const coords = await getCoords();
    if (coords) {
      const l2 = loadPremOutbox();
      const found = l2.find((x) => x.localId === rec.localId);
      if (found && !found.synced) {
        found.lat = coords.lat;
        found.lon = coords.lon;
        savePremOutbox(l2);
      }
    }
    try {
      savePremOutbox(await reconcilePremonitions(loadPremOutbox(), sendPremFn));
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setError("That PIN was rejected. Enter it again.");
        setPinReady(false);
      }
    }
  }, []);

  // The home-screen shortcuts (F15) open the app at /?action=start or
  // /?action=premonition and log immediately, so capture is one long-press + one tap.
  // Handled at most once per launch (the module-level flag survives StrictMode's
  // double-mount); the two actions are mutually exclusive on any one launch.
  useEffect(() => {
    if (!pinReady || deepLinkConsumed) return;
    const action = new URLSearchParams(window.location.search).get("action");
    if (action !== "start" && action !== "premonition") return;
    deepLinkConsumed = true;
    window.history.replaceState({}, "", window.location.pathname);

    if (action === "premonition") {
      // Fire-and-forget: a premonition is always logged (there is no "already
      // open" state to guard). Its outbox sync is now idempotent under a launch
      // race, so the tap this queues cannot be double-posted by the initial flush.
      onPremonition();
      return;
    }

    // A migraine must not open a second attack when one is already running, and
    // after a fresh launch the open attack may live only on the server, not yet in
    // the local outbox, so the guard checks the server too. The async server
    // round-trip also makes this robust to a reconcile racing on launch.
    (async () => {
      if (findOpen(loadOutbox())) return; // already open on this device
      let serverOpen = null;
      try {
        serverOpen = await apiCurrent();
      } catch {
        /* offline: fall back to the local check below */
      }
      // The initial-load effect adopts a server-open attack; don't duplicate it.
      if (serverOpen || findOpen(loadOutbox())) return;
      onStart();
    })();
  }, [pinReady, onStart, onPremonition]);

  const onEnd = useCallback(() => {
    const list = loadOutbox();
    const openRec = findOpen(list);
    if (!openRec) {
      setOpen(null);
      return;
    }
    openRec.ended_at = new Date().toISOString();
    saveOutbox(list);
    setOpen(null);
    setEndPanel(openRec); // collect optional detail, then sync
  }, []);

  const finishDetails = useCallback(
    (
      details:
        | {
            severity: number | null;
            meds: string;
            note: string;
            ended_at: string;
            attrs: Attrs;
          }
        | null
    ) => {
      if (details && endPanel) {
        const list = loadOutbox();
        const rec = list.find((x) => x.localId === endPanel.localId);
        if (rec && !rec.endedSynced) {
          rec.severity = details.severity;
          rec.meds = details.meds.trim() || null;
          rec.note = details.note.trim() || null;
          // She may know the attack ended earlier than she remembered to tap.
          rec.ended_at = details.ended_at;
          rec.attrs = attrsEmpty(details.attrs) ? null : details.attrs;
          saveOutbox(list);
        }
      }
      setEndPanel(null);
      runSync().then(refreshRecent);
    },
    [endPanel, runSync, refreshRecent]
  );

  const onSaveEdit = useCallback(
    async (id: number, patch: EditPatch) => {
      try {
        await apiPatch(id, {
          severity: patch.severity,
          meds: patch.meds.trim() || null,
          note: patch.note.trim() || null,
          started_at: patch.started_at,
          // A corrected end is optional; only send it when one is set, so clearing
          // the field never silently reopens a closed attack.
          ...(patch.ended_at ? { ended_at: patch.ended_at } : {}),
          started_at_time_known: patch.started_at_time_known ? 1 : 0,
          // ICHD-3 attributes; side is derived server-side from the regions.
          pain_regions: patch.attrs.pain_regions,
          quality: patch.attrs.quality,
          aggravated_by_activity: patch.attrs.aggravated_by_activity,
          nausea: patch.attrs.nausea,
          photophobia: patch.attrs.photophobia,
          phonophobia: patch.attrs.phonophobia,
          aura: patch.attrs.aura,
        });
        setError(null);
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          setError("That PIN was rejected. Enter it again.");
          setPinReady(false);
        }
      }
      setEditing(null);
      refreshRecent();
    },
    [refreshRecent]
  );

  const onDeleteEpisode = useCallback(
    async (id: number) => {
      try {
        await apiDelete(id);
        // Keep local state consistent if we deleted the currently-open episode.
        const list = loadOutbox().filter((e) => e.serverId !== id);
        saveOutbox(list);
        setOpen(findOpen(list) ?? null);
        setPending(pendingCount(list));
        setError(null);
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          setError("That PIN was rejected. Enter it again.");
          setPinReady(false);
        }
      }
      setEditing(null);
      refreshRecent();
    },
    [refreshRecent]
  );

  if (!pinReady) {
    return <PinGate error={error} onSubmit={() => setPinReady(true)} />;
  }

  const elapsed = open
    ? formatDuration(nowTs - new Date(open.started_at).getTime())
    : "";

  if (tab === "insights") {
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col px-6 pb-28 pt-8">
        <header className="mb-8 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-200">Aura</h1>
          <StatusPill online={online} pending={pending} />
        </header>
        <Insights onUnauthorized={handleUnauthorized} />
        <TabBar tab={tab} onChange={setTab} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col px-6 pb-28 pt-8">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-200">
          Aura
        </h1>
        <StatusPill online={online} pending={pending} />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6">
        {open ? (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={onEnd}
              className="flex aspect-square w-64 flex-col items-center justify-center rounded-full bg-ember-500/90 text-zinc-950 shadow-lg shadow-ember-900/40 transition active:scale-95"
            >
              <span className="text-sm font-medium uppercase tracking-wide">
                Migraine in progress
              </span>
              <span className="my-2 text-5xl font-bold tabular-nums">
                {open.time_known ? "" : "~"}
                {elapsed}
              </span>
              <span className="text-sm opacity-80">tap when it ends</span>
            </button>
            <StartAdjust open={open} onAdjust={adjustStart} />
            <MedPanel open={open} onLogDose={onLogDose} onLogRelief={onLogRelief} />
          </div>
        ) : (
          <button
            onClick={onStart}
            className="flex aspect-square w-64 flex-col items-center justify-center rounded-full bg-accent-500 text-white shadow-lg shadow-accent-900/40 transition active:scale-95"
          >
            <span className="text-2xl font-bold">I have a</span>
            <span className="text-2xl font-bold">migraine</span>
            <span className="mt-2 text-sm opacity-80">tap to start</span>
          </button>
        )}

        {/* The premonition. One tap, no follow-up, never linked to an attack by
            hand. Deliberately quiet so it cannot compete with the capture button. */}
        {premLoggedAt ? (
          <p className="rounded-full bg-zinc-800 px-4 py-2 text-sm text-accent-400">
            Noted at{" "}
            {new Date(premLoggedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        ) : (
          <button
            onClick={onPremonition}
            className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-300 transition active:scale-95 active:bg-zinc-800"
          >
            I feel one coming
          </button>
        )}

        {error && <p className="text-sm text-rose-400">{error}</p>}
      </main>

      <RecentList episodes={recent} onSelect={setEditing} />

      {endPanel && (
        <EndPanel
          onSave={(d) => finishDetails(d)}
          onSkip={() => finishDetails(null)}
        />
      )}

      {editing && (
        <EditPanel
          episode={editing}
          onSave={(patch) => onSaveEdit(editing.id, patch)}
          onDelete={() => onDeleteEpisode(editing.id)}
          onCancel={() => setEditing(null)}
        />
      )}

      <TabBar tab={tab} onChange={setTab} />
    </div>
  );
}

/** Two tabs, no more. Capture stays one tap from anywhere; everything derived
 *  lives behind the second, where it cannot compete with the button. */
function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const item = (id: Tab, label: string) => (
    <button
      onClick={() => onChange(id)}
      className={`flex-1 rounded-lg py-2.5 text-sm transition ${
        tab === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
      }`}
    >
      {label}
    </button>
  );
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-md gap-2 px-6 py-2">
        {item("today", "Today")}
        {item("insights", "Insights")}
      </div>
    </nav>
  );
}

function StatusPill({ online, pending }: { online: boolean; pending: number }) {
  if (!online) {
    return (
      <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-ember-300">
        Offline{pending > 0 ? ` · ${pending} queued` : ""}
      </span>
    );
  }
  if (pending > 0) {
    return (
      <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">
        Syncing {pending}…
      </span>
    );
  }
  return (
    <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-accent-400">
      Synced
    </span>
  );
}

function RecentList({
  episodes,
  onSelect,
}: {
  episodes: Episode[];
  onSelect: (e: Episode) => void;
}) {
  if (episodes.length === 0) {
    return (
      <p className="mt-8 text-center text-sm text-zinc-400">
        No migraines logged yet.
      </p>
    );
  }
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
        Recent · {episodes.length}
      </h2>
      <ul className="divide-y divide-zinc-800 rounded-xl bg-zinc-900/60">
        {episodes.map((e) => (
          <li key={e.id}>
            <button
              onClick={() => onSelect(e)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition active:bg-zinc-800/60"
            >
              <span className="text-zinc-300">
                {new Date(e.started_at).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {e.severity !== null ? (
                  <span className="ml-2 text-zinc-400 tabular-nums">
                    {e.severity}/{SEVERITY_MAX}
                  </span>
                ) : null}
              </span>
              <span className="text-zinc-400 tabular-nums">
                {e.ended_at
                  ? // A "~" flags a duration built on an estimated onset.
                    (e.started_at_time_known === 0 ? "~" : "") +
                    formatDuration(durationMs(e.started_at, e.ended_at))
                  : e.source === "app"
                    ? "ongoing"
                    : "—" /* imported: duration unknown, not in progress */}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-center text-xs text-zinc-400">
        Tap an entry to edit or delete it.
      </p>
    </section>
  );
}

interface EditPatch {
  severity: number | null;
  meds: string;
  note: string;
  started_at: string;
  ended_at: string | null;
  started_at_time_known: boolean;
  attrs: Attrs;
}

const numToBool = (v: number | null | undefined): boolean | null =>
  v == null ? null : Boolean(v);

/** Read the stored episode columns back into the editable attribute shape. */
const episodeToAttrs = (e: Episode): Attrs => ({
  pain_regions: parseRegions(e.pain_regions),
  quality: e.quality ?? null,
  aggravated_by_activity: numToBool(e.aggravated_by_activity),
  nausea: numToBool(e.nausea),
  photophobia: numToBool(e.photophobia),
  phonophobia: numToBool(e.phonophobia),
  aura: numToBool(e.aura),
});

function EditPanel({
  episode,
  onSave,
  onDelete,
  onCancel,
}: {
  episode: Episode;
  onSave: (d: EditPatch) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [severity, setSeverity] = useState<number | null>(episode.severity);
  const [meds, setMeds] = useState(episode.meds ?? "");
  const [note, setNote] = useState(episode.note ?? "");
  const [startInput, setStartInput] = useState(isoToLocalInput(episode.started_at));
  const [endInput, setEndInput] = useState(
    episode.ended_at ? isoToLocalInput(episode.ended_at) : ""
  );
  const [timeKnown, setTimeKnown] = useState(episode.started_at_time_known !== 0);
  const [attrs, setAttrs] = useState<Attrs>(episodeToAttrs(episode));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const startIso = localInputToIso(startInput);
  const endIso = endInput ? localInputToIso(endInput) : null;
  // Guard against a fat-fingered edit that would make the attack end before it began.
  const endBeforeStart = startIso !== null && endIso !== null && endIso < startIso;
  const canSave = startIso !== null && !endBeforeStart;

  const save = () => {
    if (!startIso) return;
    onSave({
      severity,
      meds,
      note,
      started_at: startIso,
      ended_at: endIso,
      started_at_time_known: timeKnown,
      attrs,
    });
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-zinc-900 p-6 sm:rounded-2xl">
        <div className="flex items-baseline justify-between">
          <h3 className="text-base font-semibold text-zinc-100">Edit entry</h3>
          <span className="text-xs text-zinc-400">
            {episode.source && episode.source !== "app" ? "imported" : "logged"}
          </span>
        </div>

        {/* Editing happens after the fact, so precise times are affordable here. */}
        <p className="mt-4 mb-2 text-xs uppercase tracking-wide text-zinc-400">
          Started
        </p>
        <input
          type="datetime-local"
          value={startInput}
          onChange={(e) => setStartInput(e.target.value)}
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none"
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={timeKnown}
            onChange={(e) => setTimeKnown(e.target.checked)}
            className="accent-accent-500"
          />
          I know the onset time (uncheck if it woke you or you noticed late)
        </label>

        <p className="mt-4 mb-2 text-xs uppercase tracking-wide text-zinc-400">
          Ended
        </p>
        <input
          type="datetime-local"
          value={endInput}
          onChange={(e) => setEndInput(e.target.value)}
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none"
        />
        {endBeforeStart && (
          <p className="mt-1 text-xs text-rose-400">
            The end is before the start.
          </p>
        )}

        <div className="mt-4">
          <SeverityInput value={severity} onChange={setSeverity} />
        </div>

        <p className="mt-4 mb-2 text-xs uppercase tracking-wide text-zinc-400">
          Meds taken
        </p>
        <input
          value={meds}
          onChange={(e) => setMeds(e.target.value)}
          placeholder="e.g. sumatriptan 50mg"
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-400 outline-none"
        />

        <VoiceNoteField value={note} onChange={setNote} />

        <p className="mt-5 mb-1 text-xs uppercase tracking-wide text-zinc-400">
          Symptoms
        </p>
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
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded-lg px-3 py-3 text-sm text-rose-400"
            >
              Delete
            </button>
            <button
              onClick={onCancel}
              className="ml-auto rounded-lg bg-zinc-800 px-5 py-3 text-sm text-zinc-300"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!canSave}
              className="rounded-lg bg-accent-500 px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Note field with dictation. A recording APPENDS to whatever is already in the
 * note (captured when recording starts) and rides through long pauses; tap again
 * to stop.
 */
function VoiceNoteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  // Never leave the mic running if the panel closes mid-recording.
  useEffect(() => () => stopRef.current?.(), []);

  const toggle = () => {
    if (listening) {
      stopRef.current?.();
      return;
    }
    const base = value; // freeze what's already typed/dictated
    setListening(true);
    stopRef.current = listen(
      (sessionText) => onChange(appendTranscript(base, sessionText)),
      () => {
        setListening(false);
        stopRef.current = null;
      }
    );
  };

  return (
    <>
      <div className="mt-4 mb-2 flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Note</p>
        {supportsVoice() && (
          <button
            onClick={toggle}
            className={`rounded-full px-3 py-1 text-xs transition ${
              listening
                ? "bg-rose-500 text-white"
                : "bg-zinc-800 text-zinc-300"
            }`}
          >
            {listening ? "● Listening, tap to stop" : "🎤 Voice"}
          </button>
        )}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder="woke up with it, behind left eye…"
        className="w-full resize-none rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-400 outline-none"
      />
      {listening && (
        <p className="mt-1 text-xs text-zinc-400">
          Take your time. Pauses are fine.
        </p>
      )}
    </>
  );
}

/**
 * Backdate the start of an in-progress attack. Quiet by default so it never
 * competes with the capture button; opens only when tapped. The offset presets
 * cover "I realised late"; "Woke with it" is the case she cannot put a time to,
 * so it keeps the current instant and only marks the onset unknown.
 */
function StartAdjust({
  open,
  onAdjust,
}: {
  open: LocalEpisode;
  onAdjust: (startedAt: string, known?: boolean) => void;
}) {
  const [show, setShow] = useState(false);
  const [exact, setExact] = useState("");

  // Compact offsets: short labels in one row. "earlier" is said once in the header,
  // so each chip need not repeat it. "Woke with it" is a different thing (onset
  // unknown, not an offset) and sits with the exact-time input below.
  const offsets = [30, 60, 120, 180, 240];
  const offsetLabel = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);

  // Build an ISO from a typed HH:MM on today's calendar day (in the device's tz).
  // A time she types is a time she remembers, so it counts as a known onset.
  const applyExact = (hhmm: string) => {
    if (!/^\d{2}:\d{2}$/.test(hhmm)) return;
    const datePart = isoToLocalInput(open.started_at).slice(0, 10);
    const iso = localInputToIso(`${datePart}T${hhmm}`);
    if (iso) {
      onAdjust(iso, true);
      setShow(false);
    }
  };

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="flex min-h-11 items-center px-2 text-xs text-zinc-400 underline underline-offset-2"
      >
        Started {open.time_known ? clockHM(open.started_at) : "earlier"} · adjust
      </button>
    );
  }

  return (
    <div className="flex w-full max-w-xs flex-col gap-2.5 rounded-2xl bg-zinc-900/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-400">Started earlier?</span>
        <button onClick={() => setShow(false)} className="text-xs text-zinc-500">
          Done
        </button>
      </div>
      <div className="flex gap-1.5">
        {offsets.map((m) => (
          <button
            key={m}
            onClick={() => {
              onAdjust(minusMinutes(nowIso(), m));
              setShow(false);
            }}
            className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-zinc-800 text-xs tabular-nums text-zinc-300 transition active:scale-95"
          >
            {offsetLabel(m)}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          type="time"
          value={exact}
          onChange={(e) => {
            setExact(e.target.value);
            applyExact(e.target.value);
          }}
          aria-label="Exact start time"
          className="min-h-11 flex-1 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100 outline-none"
        />
        <button
          onClick={() => {
            onAdjust(nowIso());
            setShow(false);
          }}
          className="flex min-h-11 items-center rounded-lg bg-zinc-800 px-3 text-xs text-zinc-300 transition active:scale-95"
        >
          Woke with it
        </button>
      </div>
      <p className="text-[11px] leading-snug text-zinc-500">
        A rough offset stays an estimate; a typed time counts as exact.
      </p>
    </div>
  );
}

/**
 * Medication, logged mid-attack. "Medication taken" stamps a dose at the current
 * time (name optional, remembered for next time). Once a dose is down, "I feel
 * better" records relief and, optionally, where the pain landed (0 = gone). The two
 * timestamps are all that time-to-effect and effectiveness are ever derived from.
 */
const LAST_MED_KEY = "aura_last_med";

function MedPanel({
  open,
  onLogDose,
  onLogRelief,
}: {
  open: LocalEpisode;
  onLogDose: (name: string | null) => void;
  onLogRelief: (residual: number | null) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [name, setName] = useState(
    () => (typeof localStorage === "undefined" ? "" : localStorage.getItem(LAST_MED_KEY) ?? "")
  );
  const [relieving, setRelieving] = useState(false);
  const [residual, setResidual] = useState<number | null>(0);

  const doses = open.doses;
  // The most recent dose still waiting on an "I feel better".
  const pending = [...doses].reverse().find((d) => d.relief_at == null);

  const logDose = () => {
    const n = name.trim();
    if (n) localStorage.setItem(LAST_MED_KEY, n);
    onLogDose(n || null);
    setComposing(false);
  };

  const logRelief = () => {
    onLogRelief(residual);
    setRelieving(false);
    setResidual(0);
  };

  return (
    <div className="flex w-full max-w-xs flex-col gap-2.5 rounded-2xl bg-zinc-900/60 p-3">
      {doses.length > 0 && (
        <ul className="flex flex-col gap-1">
          {doses.map((d) => (
            <li key={d.localId} className="flex items-baseline justify-between text-xs">
              <span className="text-zinc-300">
                💊 {d.name || "Medication"} · {clockHM(d.taken_at)}
              </span>
              <span className="tabular-nums text-zinc-500">
                {d.relief_at
                  ? `better ${clockHM(d.relief_at)}${
                      d.relief_severity != null ? ` · ${d.relief_severity}/10` : ""
                    }`
                  : "no relief yet"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {relieving ? (
        <div className="flex flex-col gap-2">
          <SeverityInput value={residual} onChange={setResidual} />
          <p className="text-[11px] leading-snug text-zinc-500">
            Where is the pain now? 0 means it is gone.
          </p>
          <div className="flex gap-1.5">
            <button
              onClick={logRelief}
              className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-accent-500 text-sm text-white transition active:scale-95"
            >
              Save
            </button>
            <button
              onClick={() => setRelieving(false)}
              className="flex min-h-11 items-center rounded-lg bg-zinc-800 px-3 text-xs text-zinc-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : composing ? (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && logDose()}
            placeholder="What did you take? (optional)"
            aria-label="Medication name"
            autoFocus
            className="min-h-11 rounded-lg bg-zinc-800 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <div className="flex gap-1.5">
            <button
              onClick={logDose}
              className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-accent-500 text-sm text-white transition active:scale-95"
            >
              Log dose now
            </button>
            <button
              onClick={() => setComposing(false)}
              className="flex min-h-11 items-center rounded-lg bg-zinc-800 px-3 text-xs text-zinc-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button
            onClick={() => setComposing(true)}
            className="flex min-h-11 flex-1 items-center justify-center rounded-lg bg-zinc-800 text-sm text-zinc-200 transition active:scale-95"
          >
            {doses.length ? "Another dose" : "Medication taken"}
          </button>
          {pending && (
            <button
              onClick={() => setRelieving(true)}
              className="flex min-h-11 flex-1 items-center justify-center rounded-lg border border-accent-500/60 text-sm text-accent-300 transition active:scale-95"
            >
              I feel better
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One severity control, used identically when ending an attack and when editing it
 *  later. Quick presets for a fast tap mid-migraine, a slider underneath for the
 *  exact 0-10 when there is time. Same everywhere, so the two never feel different. */
function SeverityInput({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Severity</p>
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
      />
      <div className="flex justify-between text-[10px] text-zinc-400">
        <span>0 none</span>
        <span>10 worst</span>
      </div>
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

const END_OFFSETS = [
  { label: "Just now", min: 0 },
  { label: "~30 min ago", min: 30 },
  { label: "~1 hr ago", min: 60 },
  { label: "~2 hr ago", min: 120 },
];

function EndPanel({
  onSave,
  onSkip,
}: {
  onSave: (d: {
    severity: number | null;
    meds: string;
    note: string;
    ended_at: string;
    attrs: Attrs;
  }) => void;
  onSkip: () => void;
}) {
  const [severity, setSeverity] = useState<number | null>(null);
  const [meds, setMeds] = useState("");
  const [note, setNote] = useState("");
  const [endMin, setEndMin] = useState(0);
  const [attrs, setAttrs] = useState<Attrs>(emptyAttrs());
  const [showSymptoms, setShowSymptoms] = useState(false);

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-zinc-900 p-6 sm:rounded-2xl">
        <h3 className="text-base font-semibold text-zinc-100">
          How was it? (optional)
        </h3>

        <p className="mt-4 mb-2 text-xs uppercase tracking-wide text-zinc-400">
          Ended
        </p>
        <div className="flex flex-wrap gap-2">
          {END_OFFSETS.map((o) => (
            <button
              key={o.min}
              onClick={() => setEndMin(o.min)}
              className={`flex min-h-11 items-center rounded-lg px-4 text-sm transition ${
                endMin === o.min
                  ? "bg-accent-500 text-white"
                  : "bg-zinc-800 text-zinc-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          <SeverityInput value={severity} onChange={setSeverity} />
        </div>

        <p className="mt-4 mb-2 text-xs uppercase tracking-wide text-zinc-400">
          Meds taken
        </p>
        <input
          value={meds}
          onChange={(e) => setMeds(e.target.value)}
          placeholder="e.g. sumatriptan 50mg"
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-400 outline-none"
        />

        <VoiceNoteField value={note} onChange={setNote} />

        {/* The ICHD-3 attributes. Optional and collapsed, so ending an attack stays
            one tap, but a description is one tap away when she has the energy. */}
        <div className="mt-4">
          {showSymptoms ? (
            <SymptomDetails value={attrs} onChange={setAttrs} />
          ) : (
            <button
              onClick={() => setShowSymptoms(true)}
              className="min-h-11 w-full rounded-lg border border-zinc-700 py-2 text-sm text-zinc-400"
            >
              Add symptom details (optional)
            </button>
          )}
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={onSkip}
            className="flex-1 rounded-lg bg-zinc-800 py-3 text-sm text-zinc-300"
          >
            Skip
          </button>
          <button
            onClick={() =>
              onSave({
                severity,
                meds,
                note,
                ended_at: minusMinutes(nowIso(), endMin),
                attrs,
              })
            }
            className="flex-1 rounded-lg bg-accent-500 py-3 text-sm font-medium text-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function PinGate({
  error,
  onSubmit,
}: {
  error: string | null;
  onSubmit: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-4 px-6">
      <h1 className="text-2xl font-bold text-zinc-100">Aura</h1>
      <p className="text-center text-sm text-zinc-400">
        Enter your access PIN to unlock logging on this device.
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="PIN"
        className="w-full rounded-lg bg-zinc-800 px-3 py-3 text-center text-zinc-100 placeholder:text-zinc-400 outline-none"
      />
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <button
        onClick={() => {
          if (!value) return;
          setPin(value);
          onSubmit();
        }}
        className="w-full rounded-lg bg-accent-500 py-3 font-medium text-white"
      >
        Unlock
      </button>
    </div>
  );
}

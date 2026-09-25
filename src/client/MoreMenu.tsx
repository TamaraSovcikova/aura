import { useState } from "react";
import { exportCsvUrl, exportDoctorUrl, exportObsidianUrl, UnauthorizedError } from "./api";

// The "⋯" menu in the header: things that are not an insight and not a capture.
// Exports used to sit at the bottom of Insights, where they read as one more
// result; they are actions on the data, so they live here, one tap away from any tab.

type Kind = "doctor" | "csv" | "obsidian";

const ITEMS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "doctor", label: "Summary for a doctor", hint: "Opens a printable page (save as PDF)" },
  { kind: "csv", label: "All attacks as CSV", hint: "For a spreadsheet" },
  { kind: "obsidian", label: "Obsidian snapshot", hint: "A markdown file for a notes vault" },
];

export default function MoreMenu({
  onUnauthorized,
  onLock,
}: {
  onUnauthorized: () => void;
  onLock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);

  const download = async (kind: Kind) => {
    setBusy(kind);
    try {
      const url =
        kind === "csv" ? await exportCsvUrl() : kind === "obsidian" ? await exportObsidianUrl() : await exportDoctorUrl();
      const a = document.createElement("a");
      a.href = url;
      if (kind === "csv") a.download = "aura-episodes.csv";
      else if (kind === "obsidian") a.download = "Aura-snapshot.md";
      else {
        a.target = "_blank";
        a.rel = "noopener";
      }
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setOpen(false);
    } catch (e) {
      if (e instanceof UnauthorizedError) onUnauthorized();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="More: export and settings"
        className="flex h-11 w-11 items-center justify-center rounded-full text-xl text-zinc-400 active:bg-zinc-800"
      >
        ⋯
      </button>
      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-md rounded-t-3xl bg-zinc-900 p-5 sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="More"
          >
            <p className="mb-2 text-xs uppercase tracking-wide text-zinc-400">Export</p>
            <ul className="divide-y divide-zinc-800 rounded-2xl bg-zinc-800/50">
              {ITEMS.map((it) => (
                <li key={it.kind}>
                  <button
                    disabled={busy !== null}
                    onClick={() => download(it.kind)}
                    className="flex min-h-14 w-full flex-col items-start justify-center px-4 py-2 text-left disabled:opacity-50"
                  >
                    <span className="text-sm text-zinc-100">{busy === it.kind ? "Preparing…" : it.label}</span>
                    <span className="text-[11px] text-zinc-500">{it.hint}</span>
                  </button>
                </li>
              ))}
            </ul>

            <p className="mb-2 mt-5 text-xs uppercase tracking-wide text-zinc-400">This device</p>
            <button
              onClick={() => {
                setOpen(false);
                onLock();
              }}
              className="flex min-h-14 w-full flex-col items-start justify-center rounded-2xl bg-zinc-800/50 px-4 py-2 text-left"
            >
              <span className="text-sm text-zinc-100">Lock</span>
              <span className="text-[11px] text-zinc-500">Forget the PIN here; it is asked for again next time</span>
            </button>

            <button onClick={() => setOpen(false)} className="mt-4 min-h-11 w-full rounded-xl text-sm text-zinc-400">
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}

import { Component, type ErrorInfo, type ReactNode } from "react";
import { loadOutbox } from "./outbox";

// A render error used to unmount the whole app and leave a blank screen. For a
// capture tool that is the worst possible failure: it happens while she is in pain,
// it says nothing, and because the cause is usually a bad record in localStorage it
// comes back on every reload. Stuck, silent, and untellable-about.
//
// This turns that into a screen that says what broke and offers a way out. Reloading
// is the first thing to try. Clearing the queue is destructive, so it states exactly
// how many unsent records would go, and copies them out first: an attack she logged
// is data that cannot be reconstructed, so nothing is discarded silently.

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The only place this is recoverable from is the console/logs, so be loud.
    console.error("Aura crashed while rendering:", error, info.componentStack);
  }

  private queuedCount(): number {
    try {
      return loadOutbox().length;
    } catch {
      return 0;
    }
  }

  private copyThenReset = async (): Promise<void> => {
    const raw = localStorage.getItem("aura_outbox") ?? "[]";
    const prem = localStorage.getItem("aura_prem_outbox") ?? "[]";
    const dump = JSON.stringify({ outbox: raw, premonitions: prem }, null, 2);
    try {
      await navigator.clipboard.writeText(dump);
    } catch {
      // Clipboard can be refused; the console copy is the fallback of last resort.
      console.error("Unsent Aura records before reset:", dump);
    }
    localStorage.removeItem("aura_outbox");
    localStorage.removeItem("aura_prem_outbox");
    location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const queued = this.queuedCount();
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-5 px-6 py-10">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Aura hit a problem</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            The screen failed to draw. Your logged attacks are safe on the server; this
            is the app, not your data.
          </p>
        </div>

        <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs text-rose-300">
          {error.message || String(error)}
        </pre>

        <button
          onClick={() => location.reload()}
          className="flex min-h-11 items-center justify-center rounded-lg bg-accent-500 text-sm text-white transition active:scale-95"
        >
          Reload
        </button>

        <div className="rounded-lg border border-zinc-800 p-3">
          <p className="text-xs leading-relaxed text-zinc-400">
            If reloading keeps landing here, something saved on this phone is the cause.
            Clearing it fixes that, but{" "}
            {queued > 0 ? (
              <>
                <strong className="text-zinc-200">
                  {queued} record{queued === 1 ? "" : "s"} not yet sent
                </strong>{" "}
                would be discarded. They are copied to your clipboard first.
              </>
            ) : (
              <>nothing is currently waiting to be sent, so this is safe.</>
            )}
          </p>
          <button
            onClick={this.copyThenReset}
            className="mt-3 flex min-h-11 items-center justify-center rounded-lg bg-zinc-800 px-4 text-sm text-zinc-300 transition active:scale-95"
          >
            Copy and clear local data
          </button>
        </div>
      </div>
    );
  }
}

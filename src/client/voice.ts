// Thin wrapper over the Web Speech API (Chrome on Android supports it).
// Degrades gracefully: if unsupported, `supportsVoice()` is false and the UI
// falls back to the plain text field.
//
// Two behaviours matter for someone dictating mid-migraine:
//  1. Long pauses must NOT end the note. Chrome ends a recognition run after a
//     short silence, so we run `continuous` and restart on `onend`, carrying the
//     finalized text forward. Only an explicit stop, a fatal error, or the
//     session cap ends it.
//  2. A recording appends to whatever is already in the note (see
//     `appendTranscript`); it never replaces it.

interface SpeechRecognitionResultLike extends ArrayLike<{ transcript: string }> {
  isFinal: boolean;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
  /** Index of the first result that changed in this event. Everything before it is
   *  already final and must not be re-read, or phrases duplicate. */
  resultIndex: number;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

// Errors that mean "give up"; `no-speech` and `aborted` are normal during a pause.
const FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
]);

// Safety net so a forgotten recording can't listen forever.
const MAX_SESSION_MS = 5 * 60 * 1000;

function getCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function supportsVoice(): boolean {
  return getCtor() !== null;
}

/** Join two chunks of text with a single space, tolerating blanks either side. */
export function appendTranscript(base: string, addition: string): string {
  const b = base.trim();
  const a = addition.trim();
  if (!b) return a;
  if (!a) return b;
  return `${b} ${a}`;
}

/**
 * Append a finalized phrase, but drop it when it just repeats the tail of what we
 * already have. On Android a restarted recognizer sometimes replays the previous
 * session's final text as the first result of the new one, which is what made
 * whole phrases duplicate. Single words are always kept (so "no no no" survives);
 * only a repeated multi-word phrase is treated as a replay.
 */
export function commitFinal(base: string, addition: string): string {
  const b = base.trim();
  const a = addition.trim();
  if (!a) return b;
  if (!b) return a;
  const multiWord = /\s/.test(a);
  if (multiWord && b.toLowerCase().endsWith(a.toLowerCase())) return b;
  return `${b} ${a}`;
}

/**
 * Start listening. `onText` receives the transcript of THIS session as it grows
 * (the caller is responsible for appending it to any pre-existing note).
 * Returns a stop function; `onDone` fires once listening has truly finished.
 */
export function listen(
  onText: (sessionText: string) => void,
  onDone: () => void
): () => void {
  const Ctor = getCtor();
  if (!Ctor) {
    onDone();
    return () => {};
  }

  let stopped = false;
  let committed = ""; // finalized text, appended once per result, carried across restarts
  let current: SpeechRecognitionLike | null = null;
  const startedAt = Date.now();

  const startInstance = () => {
    const rec = new Ctor();
    current = rec;
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = true; // ride through pauses

    // Read only the results from `resultIndex` forward: the ones that changed in
    // this event. Each result is appended to `committed` exactly once, when it turns
    // final. Re-reading from index 0 (or committing a whole instance at onend) is
    // what caused phrases to duplicate across the pause-restart cycle.
    rec.onresult = (e) => {
      let interim = "";
      // A fresh instance replays finals from index 0, so a missing resultIndex must
      // start at 0, not undefined (which would skip the loop entirely).
      for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) committed = commitFinal(committed, t);
        else interim = appendTranscript(interim, t);
      }
      onText(appendTranscript(committed, interim));
    };

    rec.onerror = (e) => {
      if (e?.error && FATAL_ERRORS.has(e.error)) stopped = true;
      // no-speech / aborted are expected during a long pause: let onend restart.
    };

    rec.onend = () => {
      const expired = Date.now() - startedAt > MAX_SESSION_MS;
      if (stopped || expired) {
        onText(committed);
        onDone();
        return;
      }
      try {
        startInstance(); // a pause ended the run, not the user
      } catch {
        onText(committed);
        onDone();
      }
    };

    try {
      rec.start();
    } catch {
      onDone();
    }
  };

  startInstance();

  return () => {
    stopped = true;
    try {
      current?.stop();
    } catch {
      onDone();
    }
  };
}

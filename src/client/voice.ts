// Thin wrapper over the Web Speech API (Chrome on Android supports it).
// Degrades gracefully: if unsupported, `supportsVoice()` is false and the UI
// falls back to the plain text field.
//
// Two behaviours matter for someone dictating mid-migraine:
//  1. Long pauses must NOT end the note. Each recognition run captures one phrase
//     and ends at a pause; we restart on `onend`, carrying the text forward. Only an
//     explicit stop, a fatal error, or the session cap ends it.
//  2. A recording appends to whatever is already in the note (see
//     `appendTranscript`); it never replaces it.
//
// Why one phrase per run rather than `continuous`: Chrome on Android handles
// continuous mode badly. Its results arrive cumulatively ("woke up", then "woke up
// with it" as a separate result) and a restarted run can replay the previous
// phrase, so appending results doubled words; and text that was still interim when
// a run ended was thrown away, so words went missing. Now each run's results are
// MERGED into one phrase (a result that extends the text replaces it, a repeat is
// dropped), a replay of the previous phrase is stripped, and whatever the run heard
// is kept when it ends, final or not.

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

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Merge one run's results into a single phrase, whatever shape the platform sends:
 * segmented ("woke up" + "with it"), cumulative ("woke up" then "woke up with it"),
 * or a repeat of text already held. A result that extends the phrase replaces it; a
 * result already contained at its end is dropped; anything else is appended.
 */
export function mergeResults(parts: string[]): string {
  let acc = "";
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    if (!acc || norm(t).startsWith(norm(acc))) acc = t;
    else if (!norm(acc).endsWith(norm(t))) acc = `${acc} ${t}`;
  }
  return acc;
}

/** Drop a replay of the previous phrase from the start of a new run's text. */
export function stripReplay(text: string, previous: string): string {
  const p = norm(previous);
  if (!p || !/\s/.test(p)) return text.trim(); // single words may legitimately repeat
  const t = text.trim();
  return norm(t).startsWith(p) ? t.slice(previous.trim().length).trim() : t;
}

/**
 * Why listening ended:
 *   - "stopped": the user stopped it (or the session cap was reached).
 *   - "paused": the browser would not restart the microphone after a pause. Chrome
 *     on Android can refuse a start that no tap triggered, so continuing needs one
 *     tap; the caller offers "Continue" and nothing already heard is lost.
 *   - "failed": the microphone is not allowed or not available at all.
 */
export type DoneReason = "stopped" | "paused" | "failed";

/** Wait before restarting after a pause; restarting inside `onend` is refused on
 *  some Android builds while the previous run is still releasing the microphone. */
export const RESTART_DELAY_MS = 250;
const RETRY_DELAY_MS = 700;
/** A restarted run that ends this fast with nothing heard was not really listening. */
const DEAD_RUN_MS = 1500;
const DEAD_RUNS_BEFORE_PAUSE = 3;

/**
 * Start listening. `onText` receives the transcript of THIS session as it grows
 * (the caller is responsible for appending it to any pre-existing note).
 * Returns a stop function; `onDone` fires once listening has truly finished.
 */
export function listen(
  onText: (sessionText: string) => void,
  onDone: (reason: DoneReason) => void
): () => void {
  const Ctor = getCtor();
  if (!Ctor) {
    onDone("failed");
    return () => {};
  }

  let finished = false;
  let stopRequested = false;
  let committed = ""; // text from finished runs, carried across restarts
  let lastPhrase = ""; // the previous run's phrase, to strip if a new run replays it
  let current: SpeechRecognitionLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadRuns = 0;
  let runs = 0;
  const startedAt = Date.now();

  const finish = (reason: DoneReason) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    onText(committed);
    onDone(reason);
  };

  const startInstance = (retry = false) => {
    const rec = new Ctor();
    current = rec;
    runs++;
    const isRestart = runs > 1;
    const runStarted = Date.now();
    let phrase = ""; // everything this run has heard so far, final or not
    let heard = false;
    let fatal: DoneReason | null = null;
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false; // one phrase per run; pauses restart it (see top)

    rec.onresult = (e) => {
      heard = true;
      // Re-read every result of this run and merge: the platform may resend earlier
      // results, grow one cumulatively, or change an interim guess.
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i++) parts.push(e.results[i][0]?.transcript ?? "");
      phrase = stripReplay(mergeResults(parts), lastPhrase);
      onText(commitFinal(committed, phrase));
    };

    rec.onerror = (e) => {
      if (!e?.error || !FATAL_ERRORS.has(e.error)) return; // no-speech / aborted: a pause
      // A permission error on the FIRST run means the mic is blocked. On a restart
      // it means the browser wanted a tap to start again: pause, do not fail.
      fatal = isRestart && e.error !== "audio-capture" ? "paused" : "failed";
    };

    rec.onend = () => {
      // Keep what this run heard even if it never turned final: dropping the last
      // interim at a pause is what lost words.
      if (phrase) {
        committed = commitFinal(committed, phrase);
        lastPhrase = phrase;
        phrase = "";
      }
      if (stopRequested || Date.now() - startedAt > MAX_SESSION_MS) return finish("stopped");
      if (fatal) return finish(fatal);

      // A run that ended almost at once, hearing nothing, was not really listening.
      // A few in a row means the restarts are being refused silently.
      deadRuns = isRestart && !heard && Date.now() - runStarted < DEAD_RUN_MS ? deadRuns + 1 : 0;
      if (deadRuns >= DEAD_RUNS_BEFORE_PAUSE) return finish("paused");

      // A pause ended the run, not the user: start again after a short gap.
      timer = setTimeout(() => {
        timer = null;
        if (!stopRequested) startInstance();
      }, RESTART_DELAY_MS);
    };

    try {
      rec.start();
    } catch {
      if (!isRestart) return finish("failed");
      if (!retry) {
        timer = setTimeout(() => {
          timer = null;
          if (!stopRequested) startInstance(true);
        }, RETRY_DELAY_MS);
        return;
      }
      finish("paused");
    }
  };

  startInstance();

  return () => {
    stopRequested = true;
    if (timer) {
      // Between runs: nothing is listening, so finish now.
      clearTimeout(timer);
      timer = null;
      finish("stopped");
      return;
    }
    try {
      current?.stop();
    } catch {
      finish("stopped");
    }
  };
}

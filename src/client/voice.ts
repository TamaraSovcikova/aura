// Thin wrapper over the Web Speech API (Chrome on Android supports it).
// Degrades gracefully: if unsupported, `supportsVoice()` is false and the UI
// falls back to the plain text field.

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function getCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function supportsVoice(): boolean {
  return typeof window !== "undefined" && getCtor() !== null;
}

/**
 * Start listening. Calls `onText` with the best transcript as it comes in.
 * Returns a stop function. Errors are swallowed to `onDone`.
 */
export function listen(
  onText: (text: string) => void,
  onDone: () => void
): () => void {
  const Ctor = getCtor();
  if (!Ctor) {
    onDone();
    return () => {};
  }
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
    }
    onText(text.trim());
  };
  rec.onerror = () => {};
  rec.onend = () => onDone();
  try {
    rec.start();
  } catch {
    onDone();
  }
  return () => {
    try {
      rec.stop();
    } catch {
      /* noop */
    }
  };
}

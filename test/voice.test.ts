// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendTranscript, listen, supportsVoice, RESTART_DELAY_MS } from "../src/client/voice";

/** Minimal stand-in for the browser's SpeechRecognition. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  /** How many upcoming start() calls should throw, as a refused restart does. */
  static failStarts = 0;
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.failStarts > 0) {
      FakeRecognition.failStarts--;
      throw new Error("InvalidStateError");
    }
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  /** Emit results; each entry becomes one SpeechRecognitionResult. `resultIndex` is
   *  the first changed index, exactly as Chrome reports it. */
  emit(parts: Array<{ text: string; final: boolean }>, resultIndex = 0) {
    const results = parts.map((p) =>
      Object.assign([{ transcript: p.text }], { isFinal: p.final })
    );
    this.onresult?.({ results, resultIndex });
  }
  /** Chrome ends the run after a silence gap. */
  endFromSilence() {
    this.onend?.();
  }
}

const latest = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];
/** A pause ends the run; the restart happens after a short delay. */
function pause() {
  latest().endFromSilence();
  vi.advanceTimersByTime(RESTART_DELAY_MS + 10);
}

function installFake() {
  FakeRecognition.instances = [];
  FakeRecognition.failStarts = 0;
  (window as unknown as Record<string, unknown>).SpeechRecognition =
    FakeRecognition;
}

describe("appendTranscript", () => {
  it("joins with a single space and tolerates blanks", () => {
    expect(appendTranscript("woke up with it", "behind left eye")).toBe(
      "woke up with it behind left eye"
    );
    expect(appendTranscript("", "first")).toBe("first");
    expect(appendTranscript("only", "")).toBe("only");
    expect(appendTranscript("  a  ", "  b  ")).toBe("a b");
  });
});

describe("listen", () => {
  beforeEach(() => {
    installFake();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("is supported when the browser exposes SpeechRecognition", () => {
    expect(supportsVoice()).toBe(true);
  });

  it("listens one phrase per run, with live interim text", () => {
    // Continuous mode on Android doubles and drops words; pauses are handled by
    // restarting instead.
    listen(() => {}, () => {});
    const rec = FakeRecognition.instances[0];
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(true);
    expect(rec.started).toBe(true);
  });

  it("restarts after a silence gap, after a short delay, instead of finishing", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.instances[0].endFromSilence();
    expect(FakeRecognition.instances).toHaveLength(1); // not inside onend
    vi.advanceTimersByTime(RESTART_DELAY_MS + 10);

    expect(onDone).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(FakeRecognition.instances[1].started).toBe(true);
  });

  it("carries text across a pause and keeps accumulating", () => {
    const texts: string[] = [];
    listen((t) => texts.push(t), () => {});

    FakeRecognition.instances[0].emit([{ text: "woke up with it", final: true }]);
    pause();
    FakeRecognition.instances[1].emit([{ text: "behind left eye", final: true }]);

    expect(texts.at(-1)).toBe("woke up with it behind left eye");
  });

  it("does not duplicate a phrase the recognizer replays after a restart", () => {
    const texts: string[] = [];
    listen((t) => texts.push(t), () => {});

    FakeRecognition.instances[0].emit([{ text: "woke up with it", final: true }]);
    pause();
    FakeRecognition.instances[1].emit([
      { text: "woke up with it", final: true },
      { text: "behind my left eye", final: true },
    ]);

    expect(texts.at(-1)).toBe("woke up with it behind my left eye");
  });

  it("does not double words when results arrive cumulatively (Android)", () => {
    const texts: string[] = [];
    listen((t) => texts.push(t), () => {});
    const rec = FakeRecognition.instances[0];

    rec.emit([{ text: "woke up", final: true }, { text: "woke up with it", final: true }]);
    expect(texts.at(-1)).toBe("woke up with it");

    rec.emit([
      { text: "woke up", final: true },
      { text: "woke up with it", final: true },
      { text: "woke up with it behind the eye", final: false },
    ]);
    expect(texts.at(-1)).toBe("woke up with it behind the eye");
  });

  it("keeps words that were still interim when a pause ended the run", () => {
    const texts: string[] = [];
    listen((t) => texts.push(t), () => {});

    FakeRecognition.instances[0].emit([{ text: "pressure behind the eye", final: false }]);
    pause();
    FakeRecognition.instances[1].emit([{ text: "since this morning", final: true }]);

    expect(texts.at(-1)).toBe("pressure behind the eye since this morning");
  });

  it("appends each result once as it finalizes within one instance", () => {
    const texts: string[] = [];
    listen((t) => texts.push(t), () => {});
    const rec = FakeRecognition.instances[0];

    rec.emit([{ text: "hello", final: false }], 0);
    rec.emit([{ text: "hello", final: true }], 0);
    rec.emit([{ text: "hello", final: true }, { text: "world", final: false }], 1);
    rec.emit([{ text: "hello", final: true }, { text: "world", final: true }], 1);

    expect(texts.at(-1)).toBe("hello world");
  });

  it("finishes only on an explicit stop, emitting the full transcript", () => {
    const texts: string[] = [];
    const onDone = vi.fn();
    const stop = listen((t) => texts.push(t), onDone);

    FakeRecognition.instances[0].emit([{ text: "took sumatriptan", final: true }]);
    stop();

    expect(onDone).toHaveBeenCalledWith("stopped");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(texts.at(-1)).toBe("took sumatriptan");
    vi.advanceTimersByTime(2000);
    expect(FakeRecognition.instances).toHaveLength(1); // no restart after stop
  });

  it("stops cleanly when Stop is tapped between runs", () => {
    const onDone = vi.fn();
    const stop = listen(() => {}, onDone);
    FakeRecognition.instances[0].endFromSilence(); // restart pending
    stop();
    expect(onDone).toHaveBeenCalledWith("stopped");
    vi.advanceTimersByTime(2000);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("keeps an interim phrase when the user stops mid-sentence", () => {
    const texts: string[] = [];
    const stop = listen((t) => texts.push(t), () => {});
    FakeRecognition.instances[0].emit([{ text: "took half a tablet", final: false }]);
    stop();
    expect(texts.at(-1)).toBe("took half a tablet");
  });

  it("fails on a permission error at the very start (mic blocked)", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.instances[0].onerror?.({ error: "not-allowed" });
    FakeRecognition.instances[0].endFromSilence();

    expect(onDone).toHaveBeenCalledWith("failed");
    vi.advanceTimersByTime(2000);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("pauses, keeping the text, when Android refuses the restart after a pause", () => {
    // The reported bug: dictation worked until a pause, then would not continue.
    const texts: string[] = [];
    const onDone = vi.fn();
    listen((t) => texts.push(t), onDone);

    FakeRecognition.instances[0].emit([{ text: "woke up with it", final: true }]);
    pause();
    FakeRecognition.instances[1].onerror?.({ error: "not-allowed" });
    FakeRecognition.instances[1].endFromSilence();

    expect(onDone).toHaveBeenCalledWith("paused");
    expect(texts.at(-1)).toBe("woke up with it");
  });

  it("retries a restart that throws once, then pauses if it throws again", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.failStarts = 2;
    pause(); // restart throws, retry scheduled
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // retry throws too
    expect(onDone).toHaveBeenCalledWith("paused");
  });

  it("recovers when only the first restart attempt throws", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.failStarts = 1;
    pause();
    vi.advanceTimersByTime(1000);
    expect(onDone).not.toHaveBeenCalled();
    expect(latest().started).toBe(true);
  });

  it("pauses when restarts keep ending at once without hearing anything", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);
    for (let n = 0; n < 4 && !onDone.mock.calls.length; n++) pause();
    expect(onDone).toHaveBeenCalledWith("paused");
  });

  it("treats no-speech as a pause and keeps listening", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.instances[0].onerror?.({ error: "no-speech" });
    pause();

    expect(onDone).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(2);
  });
});

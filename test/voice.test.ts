// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendTranscript, listen, supportsVoice } from "../src/client/voice";

/** Minimal stand-in for the browser's SpeechRecognition. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
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

function installFake() {
  FakeRecognition.instances = [];
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
  });

  it("is supported when the browser exposes SpeechRecognition", () => {
    expect(supportsVoice()).toBe(true);
  });

  it("runs continuously so pauses do not cut the note off", () => {
    listen(
      () => {},
      () => {}
    );
    const rec = FakeRecognition.instances[0];
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.started).toBe(true);
  });

  it("restarts after a silence gap instead of finishing", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.instances[0].endFromSilence();

    expect(onDone).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(FakeRecognition.instances[1].started).toBe(true);
  });

  it("carries finalized text across a pause and keeps accumulating", () => {
    const texts: string[] = [];
    listen(
      (t) => texts.push(t),
      () => {}
    );

    FakeRecognition.instances[0].emit([{ text: "woke up with it", final: true }]);
    FakeRecognition.instances[0].endFromSilence(); // long pause

    FakeRecognition.instances[1].emit([{ text: "behind left eye", final: true }]);

    expect(texts.at(-1)).toBe("woke up with it behind left eye");
  });

  it("does not duplicate a phrase the recognizer replays after a restart", () => {
    // The Android bug: the new instance replays the previous final as its first
    // result, then adds the new phrase. It must not double the replayed text.
    const texts: string[] = [];
    listen((t) => texts.push(t), () => {});

    FakeRecognition.instances[0].emit([{ text: "woke up with it", final: true }]);
    FakeRecognition.instances[0].endFromSilence();
    FakeRecognition.instances[1].emit([
      { text: "woke up with it", final: true },
      { text: "behind my left eye", final: true },
    ]);

    expect(texts.at(-1)).toBe("woke up with it behind my left eye");
  });

  it("appends each result once as it finalizes within one instance", () => {
    const texts: string[] = [];
    listen((t) => texts.push(t), () => {});
    const rec = FakeRecognition.instances[0];

    // interim "hello", then hello finalizes, then interim "world" at index 1, then
    // world finalizes. resultIndex advances so nothing is re-read.
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

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(texts.at(-1)).toBe("took sumatriptan");
    expect(FakeRecognition.instances).toHaveLength(1); // no restart after stop
  });

  it("stops on a fatal permission error rather than looping", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.instances[0].onerror?.({ error: "not-allowed" });
    FakeRecognition.instances[0].endFromSilence();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("treats no-speech as a pause and keeps listening", () => {
    const onDone = vi.fn();
    listen(() => {}, onDone);

    FakeRecognition.instances[0].onerror?.({ error: "no-speech" });
    FakeRecognition.instances[0].endFromSilence();

    expect(onDone).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(2);
  });
});

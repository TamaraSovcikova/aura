import { useEffect, useRef, useState } from "react";
import { appendTranscript, listen, supportsVoice, type DoneReason } from "./voice";

/**
 * Note field with dictation. A recording APPENDS to whatever is already in the note
 * (captured when recording starts) and rides through pauses; tap Stop to end it.
 *
 * If the browser refuses to restart the microphone after a pause (Chrome on Android
 * can insist on a tap), the field says so and offers Continue, which starts a new
 * recording appended to everything heard so far. Nothing is lost either way.
 *
 * This is where free text belongs now. Medication used to have its own free-text
 * field competing with the structured dose record; anything worth saying about a
 * dose ("half a tablet, left over from last time") is a note, not a second medication store.
 */
type State = "idle" | "listening" | "paused" | "failed";

export default function VoiceNoteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [state, setState] = useState<State>("idle");
  const listening = state === "listening";
  const stopRef = useRef<(() => void) | null>(null);
  // Set when the user types mid-dictation: the recognizer still delivers a last
  // transcript after stopping, and that must not overwrite what was typed.
  const typedOverRef = useRef(false);

  // Never leave the mic running if the panel closes mid-recording.
  useEffect(() => () => stopRef.current?.(), []);

  const start = () => {
    const base = value; // freeze what's already typed/dictated
    typedOverRef.current = false;
    setState("listening");
    stopRef.current = listen(
      (sessionText) => {
        if (!typedOverRef.current) onChange(appendTranscript(base, sessionText));
      },
      (reason: DoneReason) => {
        stopRef.current = null;
        setState(reason === "stopped" ? "idle" : reason);
      }
    );
  };

  const onButton = () => {
    if (listening) stopRef.current?.();
    else start();
  };

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm text-zinc-300">Anything else to remember?</p>
        {supportsVoice() && (
          <button
            onClick={onButton}
            aria-pressed={listening}
            className={`flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm transition active:scale-95 ${
              listening
                ? "bg-rose-500 text-white"
                : state === "paused"
                  ? "bg-accent-500 text-white"
                  : "bg-zinc-800 text-zinc-200"
            }`}
          >
            {listening ? (
              <>
                <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-white" />
                Stop
              </>
            ) : state === "paused" ? (
              "🎤 Continue"
            ) : (
              "🎤 Dictate"
            )}
          </button>
        )}
      </div>
      <textarea
        value={value}
        // Typing while dictating would be overwritten by the next phrase, so a keystroke
        // ends the recording first and the typed text wins.
        onChange={(e) => {
          if (listening) {
            typedOverRef.current = true;
            stopRef.current?.();
          }
          onChange(e.target.value);
        }}
        rows={3}
        placeholder="woke up with it, behind left eye…"
        className="w-full resize-none rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-400 outline-none"
      />
      <p className="mt-1 min-h-4 text-xs text-zinc-400" aria-live="polite">
        {state === "listening" && "Listening. Take your time, pauses are fine. Tap Stop when done."}
        {state === "paused" && "Paused after a silence. Tap Continue to keep talking; what you said is kept."}
        {state === "failed" && "The microphone is blocked or unavailable. Allow it in the browser settings, or type instead."}
      </p>
    </>
  );
}

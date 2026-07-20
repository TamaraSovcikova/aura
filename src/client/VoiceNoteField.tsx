import { useEffect, useRef, useState } from "react";
import { appendTranscript, listen, supportsVoice } from "./voice";

/**
 * Note field with dictation. A recording APPENDS to whatever is already in the note
 * (captured when recording starts) and rides through long pauses; tap again to stop.
 *
 * This is where free text belongs now. Medication used to have its own free-text
 * field competing with the structured dose record; anything worth saying about a
 * dose ("half a tablet, left over from last time") is a note, not a second medication store.
 */
export default function VoiceNoteField({
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
      <div className="mt-5 mb-2 flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Note</p>
        {supportsVoice() && (
          <button
            onClick={toggle}
            className={`rounded-full px-3 py-1 text-xs transition ${
              listening ? "bg-rose-500 text-white" : "bg-zinc-800 text-zinc-300"
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
        <p className="mt-1 text-xs text-zinc-400">Take your time. Pauses are fine.</p>
      )}
    </>
  );
}

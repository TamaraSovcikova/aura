// F19: the interactive head map.
//
// Tap regions to paint where it hurts, front and back. The painted ids are the
// value; the ICHD-3 laterality (one-sided vs both) is derived from them on the
// server via deriveSide, so this component never has to reason about criteria.
//
// Geometry lives here; the region ids and their meaning live in shared/headmap so
// the map and the derivation cannot drift apart.

import { useState } from "react";
import { HEAD_REGIONS, deriveSide, type HeadView } from "../shared/headmap";

interface Shape {
  id: string;
  // An ellipse hit-area. cx/cy/rx/ry in the 200x240 viewBox.
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

// Front view is drawn as a mirror (her left is on the left of the image).
const FRONT: Shape[] = [
  { id: "l-forehead", cx: 74, cy: 74, rx: 22, ry: 16 },
  { id: "r-forehead", cx: 126, cy: 74, rx: 22, ry: 16 },
  { id: "l-temple", cx: 42, cy: 104, rx: 17, ry: 22 },
  { id: "r-temple", cx: 158, cy: 104, rx: 17, ry: 22 },
  { id: "l-eye", cx: 78, cy: 116, rx: 18, ry: 13 },
  { id: "r-eye", cx: 122, cy: 116, rx: 18, ry: 13 },
  { id: "l-cheek", cx: 80, cy: 162, rx: 20, ry: 20 },
  { id: "r-cheek", cx: 120, cy: 162, rx: 20, ry: 20 },
];

const BACK: Shape[] = [
  { id: "crown", cx: 100, cy: 62, rx: 46, ry: 26 },
  { id: "l-occiput", cx: 74, cy: 120, rx: 26, ry: 30 },
  { id: "r-occiput", cx: 126, cy: 120, rx: 26, ry: 30 },
  { id: "neck", cx: 100, cy: 196, rx: 26, ry: 20 },
];

const labelOf = (id: string) => HEAD_REGIONS.find((r) => r.id === id)?.label ?? id;

export default function HeadMap({
  value,
  onChange,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [view, setView] = useState<HeadView>("front");
  const shapes = view === "front" ? FRONT : BACK;
  const selected = new Set(value);
  const side = deriveSide(value);

  const toggle = (id: string) => {
    const next = new Set(value);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };

  return (
    <div className="flex flex-col items-center">
      <div className="mb-2 flex gap-1 rounded-lg bg-slate-800 p-0.5 text-xs">
        {(["front", "back"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`flex min-h-11 items-center rounded-md px-5 capitalize transition ${
              view === v ? "bg-slate-700 text-slate-100" : "text-slate-400"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      <svg viewBox="0 0 200 240" className="h-72 w-auto" role="group" aria-label="Head map">
        {/* Head outline. Front adds a jaw taper; back is a plain oval. */}
        <ellipse
          cx={100}
          cy={116}
          rx={68}
          ry={92}
          className="fill-slate-800/40 stroke-slate-600"
          strokeWidth={1.5}
        />
        {view === "front" && (
          <>
            <ellipse cx={78} cy={116} rx={5} ry={6} className="fill-slate-500" />
            <ellipse cx={122} cy={116} rx={5} ry={6} className="fill-slate-500" />
            <path d="M92 150 q8 8 16 0" className="fill-none stroke-slate-500" strokeWidth={1.5} />
          </>
        )}
        {shapes.map((s) => {
          const on = selected.has(s.id);
          return (
            <ellipse
              key={s.id}
              cx={s.cx}
              cy={s.cy}
              rx={s.rx}
              ry={s.ry}
              onClick={() => toggle(s.id)}
              role="button"
              aria-label={labelOf(s.id)}
              aria-pressed={on}
              className={`cursor-pointer transition ${
                on
                  ? "fill-rose-500/70 stroke-rose-400"
                  : "fill-transparent stroke-slate-600 hover:fill-slate-700/40"
              }`}
              strokeWidth={1.5}
            />
          );
        })}
      </svg>

      <p className="mt-1 h-4 text-xs text-slate-400">
        {value.length === 0
          ? "Tap where it hurts"
          : side === "one"
            ? "One-sided"
            : "Both sides / central"}
      </p>
    </div>
  );
}

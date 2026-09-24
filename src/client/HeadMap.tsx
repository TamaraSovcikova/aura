// F19: the interactive head map.
//
// Tap regions to paint where it hurts, front and back. The painted ids are the
// value; the ICHD-3 laterality (one-sided vs both) is derived from them on the
// server via deriveSide, so this component never has to reason about criteria.
//
// Geometry lives here; the region ids and their meaning live in shared/headmap so
// the map and the derivation cannot drift apart.
//
// Both views are drawn at once, side by side, as an illustrated head (shaded face,
// features, hair, neck and shoulders) with the regions laid over it as transparent
// zones. Unpainted, a zone shows only a faint outline so the drawing reads as a
// face; painted, it fills. The same geometry renders read-only as a heat map in
// Insights and in the attack view, where `intensity` shades each zone by how often
// it was painted.

import { useId } from "react";
import { HEAD_REGIONS, deriveSide, type HeadView } from "../shared/headmap";

interface Zone {
  id: string;
  /** Path in the 200x240 viewBox, clipped to the head. Neighbours share edges. */
  d: string;
}

// The front view is a mirror: the person's left is on the left of the image, as if
// looking in a mirror, because that is how people point at their own face. The
// dividing lines follow the brow and the temples rather than a grid.
const FRONT_ZONES: Zone[] = [
  { id: "l-forehead", d: "M20 0 H100 V94 Q84 86 70 92 Q66 84 70 76 H20 Z" },
  { id: "r-forehead", d: "M180 0 H100 V94 Q116 86 130 92 Q134 84 130 76 H180 Z" },
  { id: "l-temple", d: "M20 76 H70 Q66 84 70 92 Q60 116 62 140 H20 Z" },
  { id: "r-temple", d: "M180 76 H130 Q134 84 130 92 Q140 116 138 140 H180 Z" },
  { id: "l-eye", d: "M70 92 Q84 86 100 94 V138 Q82 144 62 140 Q60 116 70 92 Z" },
  { id: "r-eye", d: "M130 92 Q116 86 100 94 V138 Q118 144 138 140 Q140 116 130 92 Z" },
  { id: "l-cheek", d: "M20 140 H62 Q82 144 100 138 V240 H20 Z" },
  { id: "r-cheek", d: "M180 140 H138 Q118 144 100 138 V240 H180 Z" },
];

// Back: the crown and neck boundaries are single curves, split at the midline so
// the left and right halves share exactly the same edge.
const BACK_ZONES: Zone[] = [
  { id: "crown", d: "M20 0 H180 V80 Q100 96 20 80 Z" },
  { id: "l-occiput", d: "M20 80 Q60 88 100 88 V172 Q60 172 20 164 Z" },
  { id: "r-occiput", d: "M180 80 Q140 88 100 88 V172 Q140 172 180 164 Z" },
  { id: "neck", d: "M20 164 Q60 172 100 172 Q140 172 180 164 V240 H20 Z" },
];

const HEAD: Record<HeadView, string> = {
  front:
    "M100 24 C68 24 48 50 47 90 C46 116 50 138 57 158 C65 180 82 199 100 201 C118 199 135 180 143 158 C150 138 154 116 153 90 C152 50 132 24 100 24 Z",
  back: "M100 22 C64 22 44 54 44 100 C44 140 56 168 76 184 L124 184 C144 168 156 140 156 100 C156 54 136 22 100 22 Z",
};

const NECK: Record<HeadView, string> = {
  front: "M81 184 C81 200 79 212 74 224 L126 224 C121 212 119 200 119 184 Z",
  back: "M79 176 C79 196 78 210 74 224 L126 224 C122 210 121 196 121 176 Z",
};

const SHOULDERS = "M74 220 C54 224 32 230 18 240 L182 240 C168 230 146 224 126 220 Z";

const labelOf = (id: string) => HEAD_REGIONS.find((r) => r.id === id)?.label ?? id;

/** The drawing under the zones: skin, neck, shoulders, ears, hair. No taps. */
function Base({ view, skin }: { view: HeadView; skin: string }) {
  return (
    <g className="pointer-events-none">
      <path d={SHOULDERS} fill="#27272a" />
      <path d={NECK[view]} fill={skin} />
      {/* Ears, behind the head outline so they sit at its edge. */}
      <g fill={skin} stroke="#52525b" strokeWidth={1.2}>
        {view === "front" ? (
          <>
            <path d="M50 98 C39 94 34 108 37 121 C39 131 45 137 52 134 Z" />
            <path d="M150 98 C161 94 166 108 163 121 C161 131 155 137 148 134 Z" />
          </>
        ) : (
          <>
            <path d="M47 102 C37 100 34 114 37 124 C39 132 44 136 49 133 Z" />
            <path d="M153 102 C163 100 166 114 163 124 C161 132 156 136 151 133 Z" />
          </>
        )}
      </g>
      <path d={HEAD[view]} fill={skin} />
      {view === "front" ? (
        // Hair: volume above the head and a soft hairline; the forehead stays visible.
        <path
          d="M47 92 C43 46 70 15 100 15 C130 15 157 46 153 92 C150 72 141 58 126 51 C112 59 88 60 72 52 C59 60 50 74 47 92 Z"
          fill="#3f3f46"
        />
      ) : (
        <>
          <path
            d="M41 104 C39 50 66 15 100 15 C134 15 161 50 159 104 C159 140 149 160 134 170 C122 164 111 168 100 166 C89 168 78 164 66 170 C51 160 41 140 41 104 Z"
            fill="#3f3f46"
          />
          <g fill="none" stroke="#52525b" strokeWidth={1.2} strokeLinecap="round">
            <path d="M100 18 C96 60 98 110 100 164" />
            <path d="M84 22 C72 60 70 110 76 162" />
            <path d="M116 22 C128 60 130 110 124 162" />
            <path d="M66 34 C52 70 50 120 60 156" />
            <path d="M134 34 C148 70 150 120 140 156" />
          </g>
        </>
      )}
    </g>
  );
}

/** Face features, drawn over the zones so a painted zone never hides them. */
function Features() {
  return (
    <g className="pointer-events-none" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <g stroke="#a1a1aa" strokeWidth={2.2}>
        <path d="M72 101 Q82 96 93 100" />
        <path d="M107 100 Q118 96 128 101" />
      </g>
      <g stroke="#a1a1aa" strokeWidth={1.3}>
        <path d="M73 113 Q83 107 93 113 Q83 119 73 113 Z" fill="#18181b" fillOpacity={0.55} />
        <path d="M107 113 Q117 107 127 113 Q117 119 107 113 Z" fill="#18181b" fillOpacity={0.55} />
      </g>
      <circle cx={83} cy={112.5} r={2.6} fill="#a1a1aa" />
      <circle cx={117} cy={112.5} r={2.6} fill="#a1a1aa" />
      <path d="M100 116 C99 128 95 139 92 146 Q96 150 100 149 Q104 150 108 146" stroke="#8b8b94" strokeWidth={1.3} />
      <path d="M86 170 Q93 166 100 168 Q107 166 114 170 Q100 178 86 170 Z" stroke="#8b8b94" strokeWidth={1.2} fill="#9f1239" fillOpacity={0.18} />
    </g>
  );
}

function HeadFigure({
  view,
  selected,
  intensity,
  onToggle,
}: {
  view: HeadView;
  selected: Set<string>;
  intensity?: Record<string, number>;
  onToggle?: (id: string) => void;
}) {
  // useId returns ":r1:"-style ids; colons break url(#...) references in some engines.
  const uid = `head-${view}-${useId().replace(/:/g, "")}`;
  const zones = view === "front" ? FRONT_ZONES : BACK_ZONES;
  const interactive = !!onToggle;
  const skin = `url(#${uid}-skin)`;

  return (
    <figure className="flex flex-1 flex-col items-center">
      <svg
        viewBox="0 0 200 240"
        className="h-56 w-full max-w-44"
        role={interactive ? "group" : "img"}
        aria-label={`Head map, ${view}`}
      >
        <defs>
          {/* Soft light from the upper front gives the flat drawing some volume. */}
          <radialGradient id={`${uid}-skin`} cx="50%" cy="38%" r="65%">
            <stop offset="0%" stopColor="#57575f" />
            <stop offset="70%" stopColor="#3a3a41" />
            <stop offset="100%" stopColor="#2c2c31" />
          </radialGradient>
          <clipPath id={`${uid}-clip`}>
            <path d={HEAD[view]} />
            {view === "back" && <path d={NECK.back} />}
          </clipPath>
        </defs>

        <Base view={view} skin={skin} />

        <g clipPath={`url(#${uid}-clip)`}>
          {zones.map((z) => {
            const on = selected.has(z.id);
            const heat = intensity?.[z.id] ?? 0;
            const style =
              intensity !== undefined
                ? {
                    fill: heat > 0 ? `rgba(244, 63, 94, ${(0.3 + heat * 0.6).toFixed(3)})` : "transparent",
                  }
                : undefined;
            return (
              <path
                key={z.id}
                d={z.d}
                onClick={onToggle ? () => onToggle(z.id) : undefined}
                role={interactive ? "button" : undefined}
                aria-label={interactive ? labelOf(z.id) : undefined}
                aria-pressed={interactive ? on : undefined}
                style={style}
                className={
                  intensity !== undefined
                    ? "stroke-white/10"
                    : `cursor-pointer transition-colors ${
                        on
                          ? "fill-rose-500/75 stroke-rose-300/70"
                          : "fill-transparent stroke-white/15 hover:fill-white/10"
                      }`
                }
                strokeWidth={1}
                strokeDasharray={on || (intensity?.[z.id] ?? 0) > 0 ? undefined : "2 3"}
              />
            );
          })}
        </g>

        {view === "front" && <Features />}
        <path d={HEAD[view]} className="pointer-events-none" fill="none" stroke="#52525b" strokeWidth={1.5} />
      </svg>
      <figcaption className="text-[11px] uppercase tracking-wide text-zinc-500">{view}</figcaption>
    </figure>
  );
}

export default function HeadMap({
  value,
  onChange,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const selected = new Set(value);
  const side = deriveSide(value);

  const toggle = (id: string) => {
    const next = new Set(value);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };

  return (
    <div className="flex flex-col items-center">
      <div className="flex w-full gap-2">
        <HeadFigure view="front" selected={selected} onToggle={toggle} />
        <HeadFigure view="back" selected={selected} onToggle={toggle} />
      </div>
      <p className="mt-1 h-4 text-xs text-zinc-400">
        {value.length === 0
          ? "Tap where it hurts"
          : side === "one"
            ? "One-sided"
            : "Both sides / central"}
      </p>
    </div>
  );
}

/**
 * Read-only heat map: every zone shaded by the share of attacks that painted it.
 * `counts` maps region id to how many attacks included it.
 */
export function HeadHeatMap({ counts }: { counts: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(counts));
  const intensity = Object.fromEntries(
    HEAD_REGIONS.map((r) => [r.id, (counts[r.id] ?? 0) / max])
  );
  const none = new Set<string>();
  return (
    <div className="flex w-full gap-2">
      <HeadFigure view="front" selected={none} intensity={intensity} />
      <HeadFigure view="back" selected={none} intensity={intensity} />
    </div>
  );
}

// F19: the interactive head map.
//
// Tap regions to paint where it hurts, front and back. The painted ids are the
// value; the ICHD-3 laterality (one-sided vs both) is derived from them on the
// server via deriveSide, so this component never has to reason about criteria.
//
// Geometry lives here; the region ids and their meaning live in shared/headmap so
// the map and the derivation cannot drift apart.
//
// Both views are drawn at once, side by side. The regions are zones that tile the
// head silhouette (clipped to it), so a painted area reads as pain on a head rather
// than a button floating over one. The same geometry renders read-only as a heat
// map in Insights, where `intensity` shades each zone by how often it was painted.

import { useId } from "react";
import { HEAD_REGIONS, deriveSide, type HeadView } from "../shared/headmap";

interface Zone {
  id: string;
  /** Path in the 200x240 viewBox, clipped to the silhouette. Neighbours share edges. */
  d: string;
}

// The front view is a mirror: the person's left is on the left of the image, as if
// looking in a mirror, because that is how people point at their own face. The
// dividing lines follow the brow and the temples rather than a grid.
const FRONT_ZONES: Zone[] = [
  { id: "l-forehead", d: "M20 0 H100 V92 Q82 84 64 92 Q60 84 62 76 H20 Z" },
  { id: "r-forehead", d: "M180 0 H100 V92 Q118 84 136 92 Q140 84 138 76 H180 Z" },
  { id: "l-temple", d: "M20 76 H62 Q60 84 64 92 Q56 114 64 138 H20 Z" },
  { id: "r-temple", d: "M180 76 H138 Q140 84 136 92 Q144 114 136 138 H180 Z" },
  { id: "l-eye", d: "M64 92 Q82 84 100 92 V136 Q82 142 64 138 Q56 114 64 92 Z" },
  { id: "r-eye", d: "M136 92 Q118 84 100 92 V136 Q118 142 136 138 Q144 114 136 92 Z" },
  { id: "l-cheek", d: "M20 138 H64 Q82 142 100 136 V240 H20 Z" },
  { id: "r-cheek", d: "M180 138 H136 Q118 142 100 136 V240 H180 Z" },
];

// Back: the crown and neck boundaries are single curves, split at the midline so
// the left and right halves share exactly the same edge.
const BACK_ZONES: Zone[] = [
  { id: "crown", d: "M20 0 H180 V80 Q100 96 20 80 Z" },
  { id: "l-occiput", d: "M20 80 Q60 88 100 88 V176 Q60 176 20 168 Z" },
  { id: "r-occiput", d: "M180 80 Q140 88 100 88 V176 Q140 176 180 168 Z" },
  { id: "neck", d: "M20 168 Q60 176 100 176 Q140 176 180 168 V240 H20 Z" },
];

const SILHOUETTE: Record<HeadView, string> = {
  front:
    "M100 20 C62 20 42 52 42 98 C42 142 54 182 78 200 C87 207 113 207 122 200 C146 182 158 142 158 98 C158 52 138 20 100 20 Z",
  back: "M100 20 C60 20 40 58 40 110 C40 150 56 178 80 190 L80 232 L120 232 L120 190 C144 178 160 150 160 110 C160 58 140 20 100 20 Z",
};

const labelOf = (id: string) => HEAD_REGIONS.find((r) => r.id === id)?.label ?? id;

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
  const clip = `head-${view}-${useId().replace(/:/g, "")}`;
  const zones = view === "front" ? FRONT_ZONES : BACK_ZONES;
  const interactive = !!onToggle;

  return (
    <figure className="flex flex-1 flex-col items-center">
      <svg
        viewBox="0 0 200 240"
        className="h-52 w-full max-w-40"
        role={interactive ? "group" : "img"}
        aria-label={`Head map, ${view}`}
      >
        <defs>
          <clipPath id={clip}>
            <path d={SILHOUETTE[view]} />
          </clipPath>
        </defs>

        {view === "front" && (
          // Ears sit outside the clip so they frame the face without being zones.
          <g className="fill-zinc-800 stroke-zinc-700" strokeWidth={1.5}>
            <path d="M44 100 C32 98 30 124 44 130 Z" />
            <path d="M156 100 C168 98 170 124 156 130 Z" />
          </g>
        )}

        <path d={SILHOUETTE[view]} className="fill-zinc-800" />

        <g clipPath={`url(#${clip})`}>
          {zones.map((z) => {
            const on = selected.has(z.id);
            const heat = intensity?.[z.id] ?? 0;
            // A zone nobody painted stays neutral; painted ones deepen with frequency.
            const style =
              intensity !== undefined
                ? {
                    fill:
                      heat > 0
                        ? `rgba(244, 63, 94, ${(0.25 + heat * 0.65).toFixed(3)})`
                        : "rgba(63, 63, 70, 0.4)",
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
                    ? "stroke-zinc-900"
                    : `cursor-pointer stroke-zinc-900 transition-colors ${
                        on ? "fill-rose-500/80" : "fill-zinc-700/40 hover:fill-zinc-600/60"
                      }`
                }
                strokeWidth={2}
              />
            );
          })}
        </g>

        {/* Features drawn over the zones, never catching taps. */}
        <g className="pointer-events-none fill-none stroke-zinc-500/70" strokeWidth={1.5} strokeLinecap="round">
          {view === "front" ? (
            <>
              <path d="M70 114 Q82 106 94 114 Q82 120 70 114 Z" />
              <path d="M106 114 Q118 106 130 114 Q118 120 106 114 Z" />
              <path d="M100 122 L95 152 Q100 156 105 152" />
              <path d="M88 174 Q100 180 112 174" />
            </>
          ) : null}
        </g>
        <path d={SILHOUETTE[view]} className="pointer-events-none fill-none stroke-zinc-600" strokeWidth={2} />
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

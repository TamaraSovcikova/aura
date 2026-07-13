// F19: the head-map regions, shared so the SVG component and the `side` derivation
// agree on one set of ids. The component owns the geometry; this owns the meaning.

export type HeadView = "front" | "back";
export type RegionSide = "l" | "r" | "m"; // left, right, midline

export interface HeadRegion {
  id: string;
  label: string;
  view: HeadView;
  side: RegionSide;
}

export const HEAD_REGIONS: HeadRegion[] = [
  { id: "l-forehead", label: "Left forehead", view: "front", side: "l" },
  { id: "r-forehead", label: "Right forehead", view: "front", side: "r" },
  { id: "l-temple", label: "Left temple", view: "front", side: "l" },
  { id: "r-temple", label: "Right temple", view: "front", side: "r" },
  { id: "l-eye", label: "Behind left eye", view: "front", side: "l" },
  { id: "r-eye", label: "Behind right eye", view: "front", side: "r" },
  { id: "l-cheek", label: "Left cheek / sinus", view: "front", side: "l" },
  { id: "r-cheek", label: "Right cheek / sinus", view: "front", side: "r" },
  { id: "crown", label: "Top of head", view: "back", side: "m" },
  { id: "l-occiput", label: "Back left", view: "back", side: "l" },
  { id: "r-occiput", label: "Back right", view: "back", side: "r" },
  { id: "neck", label: "Neck / base", view: "back", side: "m" },
];

const SIDE_OF = new Map(HEAD_REGIONS.map((r) => [r.id, r.side]));

/**
 * The ICHD-3 laterality criterion, derived from the painted regions.
 *   - regions on both sides  -> "both"
 *   - regions on one side only -> "one"
 *   - midline only (top/neck)  -> "both" (central pain is not unilateral)
 *   - nothing painted          -> null (unknown, never assumed)
 * Unknown ids are ignored rather than trusted.
 */
export function deriveSide(regionIds: string[]): "one" | "both" | null {
  const known = regionIds.filter((id) => SIDE_OF.has(id));
  if (known.length === 0) return null;
  const hasL = known.some((id) => SIDE_OF.get(id) === "l");
  const hasR = known.some((id) => SIDE_OF.get(id) === "r");
  if (hasL && hasR) return "both";
  if (hasL || hasR) return "one";
  return "both"; // midline only
}

/** Parse the stored JSON array of region ids, tolerating null and malformed text. */
export function parseRegions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

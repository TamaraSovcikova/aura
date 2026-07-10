// F6: acute medication days.
//
// ICHD-3 defines medication-overuse headache by DAYS PER MONTH on which acute
// medication is taken, and the threshold depends on the drug class:
//   * triptans, ergots, opioids, combination analgesics: >= 10 days/month
//   * simple analgesics (paracetamol, aspirin, NSAIDs):  >= 15 days/month
// both sustained for more than 3 months.
//
// Aura counts. It does not diagnose. And it counts only from actual medication
// entries, never from a self-reported trigger tag: reading the old "Medication"
// tag as a frequency signal was a real mistake, and the tag actually marked when
// an attack was treated.

export type MedClass = "triptan" | "simple_analgesic" | "other" | "none";

/** ICHD-3 day-per-month thresholds. Information for a neurologist, not a verdict. */
export const ICHD3_THRESHOLDS: Record<"triptan" | "simple_analgesic", number> = {
  triptan: 10,
  simple_analgesic: 15,
};

const TRIPTANS = [
  "sumatriptan", "rizatriptan", "zolmitriptan", "naratriptan", "eletriptan",
  "almotriptan", "frovatriptan", "avitriptan", "imigran", "imitrex", "maxalt",
  "relpax", "zomig", "triptan",
];

const SIMPLE_ANALGESICS = [
  "paracetamol", "acetaminophen", "panadol", "tylenol",
  "ibuprofen", "nurofen", "advil", "brufen",
  "aspirin", "acetylsalicylic",
  "naproxen", "diclofenac", "voltaren", "ketoprofen", "nsaid",
  "solpadeine", "nimesil", "nimesulide", "ibalgin", "paralen",
];

/** Words that mean "nothing was taken", so an entry is not a medication day. */
const NEGATIONS = ["none", "no meds", "nothing", "n/a", "na", "-", "no"];

/**
 * Classify a free-text medication entry.
 *
 * Order matters: a combination like "sumatriptan + ibuprofen" counts toward the
 * stricter triptan threshold, because that is the class ICHD-3 caps at 10 days.
 * Unrecognised text becomes `other`: it still counts as a medication day, it just
 * cannot be attributed to a threshold. Silently dropping it would undercount.
 */
export function classifyMed(text: string | null | undefined): MedClass {
  if (!text) return "none";
  const t = text.trim().toLowerCase();
  if (!t) return "none";
  if (NEGATIONS.includes(t)) return "none";

  if (TRIPTANS.some((d) => t.includes(d))) return "triptan";
  if (SIMPLE_ANALGESICS.some((d) => t.includes(d))) return "simple_analgesic";
  return "other";
}

export interface MedMonth {
  month: string; // YYYY-MM
  medication_days: number;
  triptan_days: number;
  simple_analgesic_days: number;
  unclassified_days: number;
  /** Reached the ICHD-3 day-count for its class. Sustained >3 months is what matters. */
  triptan_threshold_reached: boolean;
  analgesic_threshold_reached: boolean;
}

/**
 * Count medication DAYS per month. A day counts once no matter how many entries
 * it has, and once per class: two triptan doses on one day is still one triptan
 * day, which is exactly how the ICHD-3 criteria are counted.
 */
export function medicationDays(
  entries: Array<{ local_date: string; meds: string | null }>
): MedMonth[] {
  const byMonth = new Map<
    string,
    { any: Set<string>; triptan: Set<string>; analgesic: Set<string>; other: Set<string> }
  >();

  for (const e of entries) {
    const cls = classifyMed(e.meds);
    if (cls === "none") continue;
    const month = e.local_date.slice(0, 7);
    let m = byMonth.get(month);
    if (!m) {
      m = { any: new Set(), triptan: new Set(), analgesic: new Set(), other: new Set() };
      byMonth.set(month, m);
    }
    m.any.add(e.local_date);
    if (cls === "triptan") m.triptan.add(e.local_date);
    else if (cls === "simple_analgesic") m.analgesic.add(e.local_date);
    else m.other.add(e.local_date);
  }

  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, m]) => ({
      month,
      medication_days: m.any.size,
      triptan_days: m.triptan.size,
      simple_analgesic_days: m.analgesic.size,
      unclassified_days: m.other.size,
      triptan_threshold_reached: m.triptan.size >= ICHD3_THRESHOLDS.triptan,
      analgesic_threshold_reached: m.analgesic.size >= ICHD3_THRESHOLDS.simple_analgesic,
    }));
}

// Shared between the Worker and the client.

/** Severity is a 0-10 VAS, matching the clinical standard and the imported history. */
export const SEVERITY_MIN = 0;
export const SEVERITY_MAX = 10;

/** Quick-capture taps during an attack map onto the 0-10 scale. */
export const SEVERITY_QUICK = [
  { level: 3, label: "Mild" },
  { level: 6, label: "Moderate" },
  { level: 9, label: "Severe" },
] as const;

export interface Episode {
  id: number;
  user_id: string | null;
  started_at: string; // ISO 8601 UTC
  /** Calendar day in the local timezone. All day-based metrics group by this. */
  local_date: string | null;
  /** 0 when started_at carries a placeholder time (ambiguous imported onset). */
  started_at_time_known?: number;
  ended_at: string | null;
  severity: number | null; // 0..10 (peak)
  meds: string | null;
  note: string | null;
  // --- ICHD-3 attributes (F18). All optional; null means not recorded. ---
  /** 'one' unilateral, 'both' bilateral. Derived from the head map or set directly. */
  side?: "one" | "both" | null;
  quality?: "throbbing" | "pressing" | null;
  aggravated_by_activity?: number | null; // 0 | 1
  nausea?: number | null; // 0 | 1
  photophobia?: number | null; // 0 | 1
  phonophobia?: number | null; // 0 | 1
  aura?: number | null; // 0 | 1
  /** JSON array of painted head-map region ids (F19). Kept for redisplay only. */
  pain_regions?: string | null;
  /** 'app' | 'obsidian-import' */
  source?: string;
  /** Imported verbatim. Never feeds the trigger engine or any classification. */
  self_reported_triggers?: string | null;
  self_reported_type?: string | null;
  weather_code: number | null;
  pressure_hpa: number | null;
  temp_c: number | null;
  lat: number | null;
  lon: number | null;
  tz: string | null;
  created_at: string;
  updated_at: string;
}

export interface StartBody {
  lat?: number;
  lon?: number;
  tz?: string;
  /** Client-captured start time, used when syncing an offline log. */
  client_started_at?: string;
  /** False when the start time is an estimate (backdated or woken-with). Kept out
   *  of the premonition lead-time analysis so a guess never reads as a measurement. */
  started_at_time_known?: boolean;
}

export interface EndBody {
  severity?: number;
  meds?: string;
  note?: string;
  /** Client-captured end time, used when syncing an offline log. */
  client_ended_at?: string;
  // Optional ICHD-3 attributes captured in the post-attack panel (F18/F19).
  side?: "one" | "both" | null;
  quality?: "throbbing" | "pressing" | null;
  aggravated_by_activity?: boolean | null;
  nausea?: boolean | null;
  photophobia?: boolean | null;
  phonophobia?: boolean | null;
  aura?: boolean | null;
  /** Painted head-map region ids; `side` is derived from these when present. */
  pain_regions?: string[] | null;
}

/** A medication dose taken during an attack. `relief_at`/`relief_severity` stay
 *  null until she taps "I feel better": that gap is the signal a dose did nothing. */
export interface MedDose {
  id: number;
  episode_id: number;
  name: string | null;
  taken_at: string; // ISO 8601 UTC
  relief_at: string | null; // ISO 8601 UTC, null while no relief recorded
  relief_severity: number | null; // 0..10 residual, null until relief recorded
  created_at: string;
}

/** Log a dose. `name` is optional (a fast tap need not name the pill); `taken_at`
 *  lets an offline log carry the real time it was taken, not the sync time. */
export interface DoseBody {
  name?: string | null;
  client_taken_at?: string;
}

/** Record that a logged dose brought relief: when, and to what residual level. */
export interface ReliefBody {
  relief_severity?: number | null;
  client_relief_at?: string;
}

/** A logged period start (F13). `cycle_day` is never stored: it is derived. */
export interface CycleEvent {
  id: number;
  local_date: string;
  kind: "period_start";
  note: string | null;
  source: string;
  created_at: string;
}

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
}

export interface EndBody {
  severity?: number;
  meds?: string;
  note?: string;
  /** Client-captured end time, used when syncing an offline log. */
  client_ended_at?: string;
}

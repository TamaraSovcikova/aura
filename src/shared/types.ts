// Shared between the Worker and the client.

export interface Episode {
  id: number;
  user_id: string | null;
  started_at: string; // ISO 8601 UTC
  ended_at: string | null;
  severity: number | null; // 1..3
  meds: string | null;
  note: string | null;
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

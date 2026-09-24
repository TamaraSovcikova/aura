import type {
  Episode,
  StartBody,
  EndBody,
  CycleEvent,
  MedDose,
  DoseBody,
  ReliefBody,
} from "../shared/types";
// Type-only: erased at build, so no worker code reaches the bundle. Importing the
// server's own return type means the client cannot drift from what /api/summary
// actually sends.
import type { Summary } from "../worker/insights";
import type { DayOfWeekAnalysis, TimeOfDayAnalysis } from "../worker/patterns";
import type { MedResponse } from "../worker/meds";
import type { TriggerAnalysis } from "../worker/triggers";
import type { MenstrualAnalysis } from "../worker/cycle";

export interface Patterns {
  day_of_week: DayOfWeekAnalysis;
  time_of_day: TimeOfDayAnalysis;
}

const PIN_KEY = "aura_pin";

export const getPin = (): string => localStorage.getItem(PIN_KEY) ?? "";
export const setPin = (pin: string): void => localStorage.setItem(PIN_KEY, pin);
export const hasPin = (): boolean => getPin().length > 0;

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getPin()}`,
  };
}

async function parse<T>(r: Response, what: string): Promise<T> {
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok) throw new Error(`${what} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

export async function apiStart(body: StartBody): Promise<Episode> {
  const r = await fetch("/api/episodes/start", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return parse<Episode>(r, "start");
}

export async function apiEnd(id: number, body: EndBody): Promise<Episode> {
  const r = await fetch(`/api/episodes/${id}/end`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return parse<Episode>(r, "end");
}

export async function apiCurrent(): Promise<Episode | null> {
  const r = await fetch("/api/episodes/current", { headers: authHeaders() });
  return parse<Episode | null>(r, "current");
}

export async function apiList(limit = 30): Promise<Episode[]> {
  const r = await fetch(`/api/episodes?limit=${limit}`, {
    headers: authHeaders(),
  });
  return parse<Episode[]>(r, "list");
}

/** Everything the edit panel can change. Attribute booleans go over the wire as
 *  booleans; the server coerces them to 0/1 and derives `side` from any regions. */
export interface EpisodePatch {
  severity?: number | null;
  meds?: string | null;
  note?: string | null;
  started_at?: string;
  ended_at?: string | null;
  started_at_time_known?: number;
  side?: "one" | "both" | null;
  quality?: "throbbing" | "pressing" | null;
  aggravated_by_activity?: boolean | null;
  nausea?: boolean | null;
  photophobia?: boolean | null;
  phonophobia?: boolean | null;
  aura?: boolean | null;
  pain_regions?: string[] | null;
}

export async function apiPatch(id: number, body: EpisodePatch): Promise<Episode> {
  const r = await fetch(`/api/episodes/${id}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return parse<Episode>(r, "patch");
}

export interface PremonitionBody {
  lat?: number;
  lon?: number;
  tz?: string;
  note?: string;
  client_felt_at?: string;
}

export async function apiPremonition(body: PremonitionBody): Promise<unknown> {
  const r = await fetch("/api/premonitions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return parse<unknown>(r, "premonition");
}

export async function apiPremonitionCount(): Promise<number> {
  const r = await fetch("/api/premonitions?limit=200", { headers: authHeaders() });
  const list = await parse<unknown[]>(r, "premonitions");
  return list.length;
}

// --- Insights, cycle, export (F5 / F6 / F7 / F8 / F13) ---------------------

export async function apiSummary(): Promise<Summary> {
  const r = await fetch("/api/summary", { headers: authHeaders() });
  return parse<Summary>(r, "summary");
}

export async function apiPatterns(): Promise<Patterns> {
  const r = await fetch("/api/patterns", { headers: authHeaders() });
  return parse<Patterns>(r, "patterns");
}

export async function apiTriggers(): Promise<TriggerAnalysis> {
  const r = await fetch("/api/triggers", { headers: authHeaders() });
  return parse<TriggerAnalysis>(r, "triggers");
}

export async function apiCycleAnalysis(): Promise<MenstrualAnalysis> {
  const r = await fetch("/api/cycle/analysis", { headers: authHeaders() });
  return parse<MenstrualAnalysis>(r, "cycle analysis");
}

// --- Medication doses ------------------------------------------------------

/** Log a dose against an episode; resolves to the new dose's server id. */
export async function apiLogDose(episodeId: number, body: DoseBody): Promise<number> {
  const r = await fetch(`/api/episodes/${episodeId}/meds`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const dose = await parse<MedDose>(r, "log dose");
  return dose.id;
}

/** Record that a logged dose brought relief (when + residual level). */
export async function apiLogRelief(doseId: number, body: ReliefBody): Promise<void> {
  const r = await fetch(`/api/meds/${doseId}/relief`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  await parse<MedDose>(r, "log relief");
}

/** Remove a dose logged by mistake. It feeds the overuse day count, so an
 *  uncorrectable mis-tap would permanently inflate a clinical number. */
export async function apiDeleteDose(doseId: number): Promise<void> {
  const r = await fetch(`/api/meds/${doseId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (r.status === 401) throw new UnauthorizedError();
  // 404 is fine: already gone.
  if (!r.ok && r.status !== 404) throw new Error(`delete dose failed: ${r.status}`);
}

export async function apiListDoses(episodeId: number): Promise<MedDose[]> {
  const r = await fetch(`/api/episodes/${episodeId}/meds`, { headers: authHeaders() });
  return parse<MedDose[]>(r, "list doses");
}

export async function apiMedResponse(): Promise<MedResponse> {
  const r = await fetch("/api/meds/response", { headers: authHeaders() });
  return parse<MedResponse>(r, "med response");
}

export async function apiCycleList(): Promise<CycleEvent[]> {
  const r = await fetch("/api/cycle", { headers: authHeaders() });
  return parse<CycleEvent[]>(r, "cycle");
}

export async function apiLogPeriod(localDate: string): Promise<CycleEvent> {
  const r = await fetch("/api/cycle", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ local_date: localDate }),
  });
  return parse<CycleEvent>(r, "log period");
}

export async function apiCycleDelete(id: number): Promise<void> {
  const r = await fetch(`/api/cycle/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok && r.status !== 404) throw new Error(`delete failed: ${r.status}`);
}

/**
 * The exports are PIN-guarded GETs, so a plain <a href> would not carry the
 * Authorization header. Passing the PIN as a query parameter instead would leak
 * it into browser history, referrers and every proxy log in between. Fetch with
 * the header and hand the browser a blob it already holds.
 */
async function fetchBlob(path: string, mime: string): Promise<string> {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${getPin()}` } });
  if (r.status === 401) throw new UnauthorizedError();
  if (!r.ok) throw new Error(`export failed: ${r.status}`);
  return URL.createObjectURL(new Blob([await r.text()], { type: mime }));
}

export const exportCsvUrl = () => fetchBlob("/api/export/episodes.csv", "text/csv");
export const exportDoctorUrl = () => fetchBlob("/api/export/doctor", "text/html");
export const exportObsidianUrl = () => fetchBlob("/api/export/obsidian", "text/markdown");

export async function apiDelete(id: number): Promise<void> {
  const r = await fetch(`/api/episodes/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (r.status === 401) throw new UnauthorizedError();
  // 404 is fine: already gone.
  if (!r.ok && r.status !== 404) throw new Error(`delete failed: ${r.status}`);
}

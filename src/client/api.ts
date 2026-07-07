import type { Episode, StartBody, EndBody } from "../shared/types";

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

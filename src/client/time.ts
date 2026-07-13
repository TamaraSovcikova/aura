// Pure time helpers shared by the capture screen's backdate and edit affordances.
// Kept separate from App so they can be tested without mounting the UI.

export const nowIso = () => new Date().toISOString();

export const minusMinutes = (iso: string, m: number) =>
  new Date(Date.parse(iso) - m * 60_000).toISOString();

export const clockHM = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * ISO instant -> the value a <input type="datetime-local"> expects, in the
 * device's local time. Editing is rare and almost always done in the same zone
 * the attack occurred, and the server recomputes local_date from the episode's
 * stored tz regardless, so the device zone here is a safe approximation.
 */
export const isoToLocalInput = (iso: string): string => {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};

export const localInputToIso = (v: string): string | null => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

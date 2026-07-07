// Best-effort context enrichment from Open-Meteo (free, no API key).
// Never throws: any failure returns empty values so a capture is never blocked.

export interface Enrichment {
  weather_code: number | null;
  pressure_hpa: number | null;
  temp_c: number | null;
}

const EMPTY: Enrichment = {
  weather_code: null,
  pressure_hpa: null,
  temp_c: null,
};

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Round to ~2dp (roughly 1km) so we never store a precise home location. */
export function roundCoord(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Pure mapper from an Open-Meteo `current` object to our columns. Unit-tested. */
export function mapOpenMeteoCurrent(current: unknown): Enrichment {
  if (!current || typeof current !== "object") return { ...EMPTY };
  const c = current as Record<string, unknown>;
  return {
    weather_code: numOrNull(c.weather_code),
    pressure_hpa: numOrNull(c.surface_pressure),
    temp_c: numOrNull(c.temperature_2m),
  };
}

export async function fetchEnrichment(
  lat?: number,
  lon?: number
): Promise<Enrichment> {
  if (
    lat === undefined ||
    lon === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return { ...EMPTY };
  }
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,surface_pressure,weather_code`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ...EMPTY };
    const data = (await res.json()) as { current?: unknown };
    return mapOpenMeteoCurrent(data.current);
  } catch {
    return { ...EMPTY };
  }
}

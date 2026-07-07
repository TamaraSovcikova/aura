import { describe, it, expect } from "vitest";
import { mapOpenMeteoCurrent, roundCoord } from "../src/worker/enrich";

describe("enrichment mapper", () => {
  it("maps Open-Meteo current fields to columns", () => {
    expect(
      mapOpenMeteoCurrent({
        temperature_2m: 12.3,
        surface_pressure: 1008.5,
        weather_code: 61,
      })
    ).toEqual({ temp_c: 12.3, pressure_hpa: 1008.5, weather_code: 61 });
  });

  it("returns nulls for missing or junk input", () => {
    const empty = { temp_c: null, pressure_hpa: null, weather_code: null };
    expect(mapOpenMeteoCurrent(null)).toEqual(empty);
    expect(mapOpenMeteoCurrent({ temperature_2m: "x" })).toEqual(empty);
  });

  it("rounds coordinates to ~2dp so a precise location is never stored", () => {
    expect(roundCoord(51.507351)).toBe(51.51);
    expect(roundCoord(-0.127758)).toBe(-0.13);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { aggregateDays, dateRange, dayOfWeek } from "../src/shared/weather";
import { blocksByLocation, locationFor, nearBoundary, type LocationRow } from "../src/worker/days";
// @ts-expect-error - plain .mjs tooling module
import { TIMELINE } from "../scripts/lib/timeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** 24 hourly readings for one local day. */
function day(date: string, pressures: number[]) {
  return {
    time: pressures.map((_, h) => `${date}T${String(h).padStart(2, "0")}:00`),
    surface_pressure: pressures,
  };
}

function concat(...days: ReturnType<typeof day>[]) {
  return {
    time: days.flatMap((d) => d.time),
    surface_pressure: days.flatMap((d) => d.surface_pressure),
  };
}

const flat = (v: number) => Array(24).fill(v);

describe("aggregateDays", () => {
  it("computes mean, min and max pressure per local day", () => {
    const hourly = day("2025-03-01", [...Array(24)].map((_, i) => 1000 + i));
    const [d] = aggregateDays(hourly, undefined);
    expect(d.local_date).toBe("2025-03-01");
    expect(d.pressure_min_hpa).toBe(1000);
    expect(d.pressure_max_hpa).toBe(1023);
    expect(d.pressure_mean_hpa).toBe(1011.5);
  });

  it("leaves the first day's 24h delta null, then computes it against the day before", () => {
    const hourly = concat(day("2025-03-01", flat(1010)), day("2025-03-02", flat(1000)));
    const [a, b] = aggregateDays(hourly, undefined);
    expect(a.pressure_delta_24h).toBeNull();
    expect(b.pressure_delta_24h).toBe(-10); // a 10 hPa fall
  });

  it("seeds the delta from the previous block so a boundary day is not silently null", () => {
    const hourly = day("2025-03-02", flat(1000));
    const [d] = aggregateDays(hourly, undefined, 1010);
    expect(d.pressure_delta_24h).toBe(-10);
  });

  it("finds the sharpest 3-hour fall, including one that straddles midnight", () => {
    // Steady, then a 6 hPa fall over the 3 hours spanning 22:00 -> 01:00.
    const d1 = flat(1010);
    d1[22] = 1010;
    d1[23] = 1007;
    const d2 = flat(1004);
    d2[0] = 1005;
    d2[1] = 1004;
    const hourly = concat(day("2025-03-01", d1), day("2025-03-02", d2));
    const [a] = aggregateDays(hourly, undefined);
    // The fall beginning at 22:00 on the 1st is attributed to the 1st.
    expect(a.pressure_drop_max_3h).toBeLessThanOrEqual(-6);
  });

  it("ignores null hourly readings rather than treating them as zero", () => {
    const hourly = {
      time: ["2025-03-01T00:00", "2025-03-01T01:00", "2025-03-01T02:00"],
      surface_pressure: [1000, null, 1002] as (number | null)[],
    };
    const [d] = aggregateDays(hourly, undefined);
    expect(d.pressure_mean_hpa).toBe(1001);
    expect(d.pressure_min_hpa).toBe(1000);
  });

  it("converts daylight seconds to hours and carries the weather code", () => {
    const hourly = day("2025-06-21", flat(1015));
    const daily = {
      time: ["2025-06-21"],
      weather_code: [3],
      temperature_2m_max: [24.4],
      temperature_2m_min: [11.1],
      daylight_duration: [59693.76],
    };
    const [d] = aggregateDays(hourly, daily);
    expect(d.daylight_hours).toBeCloseTo(16.58, 2);
    expect(d.weather_code).toBe(3);
    expect(d.temp_max_c).toBe(24.4);
  });

  it("labels the day of week", () => {
    expect(dayOfWeek("2026-07-10")).toBe(5); // Friday
  });
});

describe("dateRange", () => {
  it("is inclusive at both ends and crosses a month boundary", () => {
    expect(dateRange("2025-01-30", "2025-02-02")).toEqual([
      "2025-01-30",
      "2025-01-31",
      "2025-02-01",
      "2025-02-02",
    ]);
  });
});

describe("location blocking", () => {
  const locs: LocationRow[] = [
    { from_date: "2025-06-25", to_date: "2025-06-30", place: "London, UK", tz: "Europe/London", lat: 51.51, lon: -0.13 },
    { from_date: "2025-07-01", to_date: "2025-07-05", place: "Vienna, AT", tz: "Europe/Vienna", lat: 48.21, lon: 16.37 },
  ];

  it("splits a range into one contiguous block per location", () => {
    const blocks = blocksByLocation(locs, "2025-06-28", "2025-07-03");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ from: "2025-06-28", to: "2025-06-30" });
    expect(blocks[1]).toMatchObject({ from: "2025-07-01", to: "2025-07-03" });
    expect(blocks[1].loc.tz).toBe("Europe/Vienna");
  });

  it("skips days with no timeline coverage rather than guessing a location", () => {
    const blocks = blocksByLocation(locs, "2025-06-20", "2025-06-26");
    expect(blocks[0].from).toBe("2025-06-25");
  });

  it("flags days adjacent to a move, where a front may have passed while travelling", () => {
    expect(nearBoundary(locs, "2025-06-30")).toBe(true); // the day she left
    expect(nearBoundary(locs, "2025-07-01")).toBe(true); // the day she arrived
    expect(nearBoundary(locs, "2025-07-02")).toBe(true); // one day after
  });

  it("does not treat the outer edges of the timeline as a move", () => {
    // The first day she ever logged, and the open-ended far-future end date, are
    // edges of the data, not journeys. Flagging them would be pure noise.
    expect(nearBoundary(locs, "2025-06-25")).toBe(false); // first day of the first block
    expect(nearBoundary(locs, "2025-07-05")).toBe(false); // last day of the last block
  });

  it("resolves the location for a date", () => {
    expect(locationFor(locs, "2025-07-02")?.place).toBe("Vienna, AT");
    expect(locationFor(locs, "2020-01-01")).toBeNull();
  });
});

describe("timeline and migration cannot drift", () => {
  // The importer reads scripts/lib/timeline.mjs; the Worker reads the `locations`
  // table seeded by migration 0004. If they disagree, weather is attributed to the
  // wrong country and every trigger conclusion is quietly wrong.
  const sql = readFileSync(join(here, "..", "migrations", "0004_locations_and_days.sql"), "utf8");

  it("seeds every timeline row into the locations table", () => {
    for (const row of TIMELINE as Array<Record<string, string | number>>) {
      expect(sql).toContain(`'${row.from}'`);
      expect(sql).toContain(`'${row.to}'`);
      expect(sql).toContain(`'${row.place}'`);
      expect(sql).toContain(`'${row.tz}'`);
      expect(sql).toContain(String(row.lat));
      expect(sql).toContain(String(row.lon));
    }
  });

  it("seeds exactly as many rows as the timeline has", () => {
    const inserted = sql.slice(sql.indexOf("INSERT INTO locations")).split("),").length;
    expect(inserted).toBe((TIMELINE as unknown[]).length);
  });
});

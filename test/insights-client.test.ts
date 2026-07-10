import { describe, it, expect } from "vitest";
import { shiftDay } from "../src/client/Insights";
import { localDateInTz } from "../src/shared/health";

describe("shiftDay", () => {
  it("steps back across a month boundary", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("steps back across a leap day", () => {
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("is not moved by a DST transition", () => {
    // 2026-03-29 is the spring-forward day in Europe. Local-time arithmetic would
    // land on 23:00 the previous evening and slide the date.
    expect(shiftDay("2026-03-30", -1)).toBe("2026-03-29");
    expect(shiftDay("2026-10-26", -1)).toBe("2026-10-25");
  });
});

describe("the day a period tap belongs to", () => {
  it("is her calendar day, not UTC's", () => {
    // 23:30 UTC on the 9th is already the 10th in Berlin. Slicing the ISO string
    // would log the period a day early, and every derived cycle day with it.
    const iso = "2026-07-09T23:30:00.000Z";
    expect(localDateInTz(iso, "Europe/Berlin")).toBe("2026-07-10");
    expect(localDateInTz(iso, "UTC")).toBe("2026-07-09");
  });

  it("holds in the other direction too", () => {
    // 00:30 UTC on the 10th is still the 9th in New York.
    const iso = "2026-07-10T00:30:00.000Z";
    expect(localDateInTz(iso, "America/New_York")).toBe("2026-07-09");
  });
});

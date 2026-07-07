import { describe, it, expect } from "vitest";
import { durationMs, formatDuration } from "../src/shared/format";

describe("duration", () => {
  it("computes elapsed ms between two ISO times", () => {
    expect(
      durationMs("2026-07-07T10:00:00.000Z", "2026-07-07T11:23:00.000Z")
    ).toBe(83 * 60 * 1000);
  });

  it("formats hours, minutes, seconds", () => {
    expect(formatDuration(83 * 60 * 1000)).toBe("1h 23m");
    expect(formatDuration(12 * 60 * 1000)).toBe("12m");
    expect(formatDuration(45 * 1000)).toBe("45s");
  });

  it("clamps negatives to 0s", () => {
    expect(formatDuration(-5)).toBe("0s");
  });
});

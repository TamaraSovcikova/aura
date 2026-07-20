import { describe, it, expect } from "vitest";
import {
  ESTIMATE,
  attackTimes,
  clockHM,
  dayShort,
  durationMs,
  endState,
  formatDuration,
  isoWithClock,
  isoToLocalInput,
  marked,
} from "../src/client/time";

// Clock rendering depends on the runner's timezone, so these assert the RULES
// (marking, pairing, labelling) against the module's own primitives rather than
// hardcoded wall-clock strings.

const START = "2026-07-15T08:00:00.000Z";
const END = "2026-07-15T14:02:00.000Z";

describe("estimate marking", () => {
  it("marks a time only when it is not known", () => {
    expect(marked("14:45", true)).toBe("14:45");
    expect(marked("14:45", false)).toBe(`${ESTIMATE}14:45`);
  });
});

describe("endState", () => {
  it("is ended when there is an end time", () => {
    expect(endState(END, "app")).toBe("ended");
  });

  it("is ongoing for an app capture with no end", () => {
    expect(endState(null, "app")).toBe("ongoing");
    expect(endState(null, undefined)).toBe("ongoing");
  });

  it("is unknown for an imported row with no end, not ongoing", () => {
    // The diary never recorded an end; the migraine is not still running.
    expect(endState(null, "obsidian")).toBe("unknown");
  });
});

describe("attackTimes", () => {
  it("shows start and end together, never the start alone", () => {
    const t = attackTimes({ started_at: START, ended_at: END, started_at_time_known: 1 });
    expect(t.range).toBe(`${clockHM(START)} → ${clockHM(END)}`);
    expect(t.end).toBe(clockHM(END));
  });

  it("marks BOTH the start and the derived duration when the onset is an estimate", () => {
    const t = attackTimes({ started_at: START, ended_at: END, started_at_time_known: 0 });
    // The old bug: an exact-looking start next to an approximate duration.
    expect(t.start.startsWith(ESTIMATE)).toBe(true);
    expect(t.duration).toBe(`${ESTIMATE}${formatDuration(durationMs(START, END))}`);
    expect(t.estimated).toBe(true);
  });

  it("marks the clock but NOT the date: a backdated onset still knows its day", () => {
    const t = attackTimes({ started_at: START, ended_at: END, started_at_time_known: 0 });
    // "~15 Jul, 07:26" would claim the day is a guess. It is not.
    expect(t.startFull.startsWith(ESTIMATE)).toBe(false);
    expect(t.startFull).toBe(`${dayShort(START)}, ${ESTIMATE}${clockHM(START)}`);
  });

  it("leaves an exactly-known attack unmarked throughout", () => {
    const t = attackTimes({ started_at: START, ended_at: END, started_at_time_known: 1 });
    expect(t.start).not.toContain(ESTIMATE);
    expect(t.duration).not.toContain(ESTIMATE);
    expect(t.estimated).toBe(false);
  });

  it("treats a missing time_known flag as known (records predating the flag)", () => {
    const t = attackTimes({ started_at: START, ended_at: END });
    expect(t.estimated).toBe(false);
  });

  it("labels a running attack 'ongoing' with no duration", () => {
    const t = attackTimes({ started_at: START, ended_at: null, source: "app" });
    expect(t.end).toBe("ongoing");
    expect(t.duration).toBeNull();
    expect(t.range.endsWith("ongoing")).toBe(true);
  });

  it("labels an imported row with no end 'unknown', distinct from ongoing", () => {
    const t = attackTimes({ started_at: START, ended_at: null, source: "obsidian" });
    expect(t.end).toBe("unknown");
    expect(t.duration).toBeNull();
  });
});

describe("isoWithClock", () => {
  it("keeps the calendar day and applies the typed clock time", () => {
    const iso = isoWithClock(START, "06:30");
    expect(iso).not.toBeNull();
    // Same local calendar day as the original, at the typed local time.
    expect(isoToLocalInput(iso as string).slice(0, 10)).toBe(isoToLocalInput(START).slice(0, 10));
    expect(isoToLocalInput(iso as string).slice(11, 16)).toBe("06:30");
  });

  it("rejects a malformed clock rather than inventing a time", () => {
    expect(isoWithClock(START, "6:30")).toBeNull();
    expect(isoWithClock(START, "")).toBeNull();
  });
});

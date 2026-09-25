import { describe, it, expect } from "vitest";
// @ts-expect-error - plain .mjs helper, intentionally untyped tooling
import {
  parseOnset,
  zonedToUtcIso,
  sqlLit,
  rowToEpisode,
  episodeToSql,
  locationForDate,
} from "../scripts/lib/obsidian.mjs";

describe("parseOnset", () => {
  it("parses the unambiguous formats found in the real data", () => {
    expect(parseOnset("4:30pm")).toEqual({ hour: 16, minute: 30 });
    expect(parseOnset("9am")).toEqual({ hour: 9, minute: 0 });
    expect(parseOnset("12pm")).toEqual({ hour: 12, minute: 0 }); // noon
    expect(parseOnset("12am")).toEqual({ hour: 0, minute: 0 }); // midnight
    expect(parseOnset("8pm ish?")).toEqual({ hour: 20, minute: 0 });
  });

  it("treats an hour past 12 as 24-hour and ignores a stray suffix", () => {
    expect(parseOnset("17:50pm")).toEqual({ hour: 17, minute: 50 });
    expect(parseOnset("13pm")).toEqual({ hour: 13, minute: 0 });
  });

  it("takes the first token, and lets a single meridiem govern a range", () => {
    expect(parseOnset("6:30pm or 3:00am")).toEqual({ hour: 18, minute: 30 });
    expect(parseOnset("8:30-9pm")).toEqual({ hour: 20, minute: 30 });
    expect(parseOnset("2pm, weak but steady and long lasting.")).toEqual({
      hour: 14,
      minute: 0,
    });
  });

  it("refuses to guess when the time is ambiguous or absent", () => {
    // Bare times could be am or pm. Guessing would silently invent data.
    expect(parseOnset("8:30")).toBeNull();
    expect(parseOnset("9:30")).toBeNull();
    expect(parseOnset("6")).toBeNull();
    expect(parseOnset("Usually at around 10")).toBeNull();
    expect(parseOnset("morning")).toBeNull();
    expect(parseOnset("Night")).toBeNull();
    expect(parseOnset("all night long")).toBeNull();
    expect(parseOnset("-last night")).toBeNull();
    expect(parseOnset("6lm")).toBeNull();
    expect(parseOnset("")).toBeNull();
    expect(parseOnset(null)).toBeNull();
  });

  it("rejects impossible clock values", () => {
    expect(parseOnset("25:00")).toBeNull();
    expect(parseOnset("10:75am")).toBeNull();
  });
});

describe("zonedToUtcIso", () => {
  it("converts London summer time (BST, UTC+1)", () => {
    expect(zonedToUtcIso("2025-06-15", 12, 0, "Europe/London")).toBe(
      "2025-06-15T11:00:00.000Z"
    );
  });

  it("converts London winter time (GMT, UTC+0)", () => {
    expect(zonedToUtcIso("2025-01-15", 12, 0, "Europe/London")).toBe(
      "2025-01-15T12:00:00.000Z"
    );
  });

  it("converts Vienna summer time (CEST, UTC+2)", () => {
    expect(zonedToUtcIso("2025-07-15", 12, 0, "Europe/Vienna")).toBe(
      "2025-07-15T10:00:00.000Z"
    );
  });

  it("noon anchoring never drifts the local date across midnight", () => {
    // The whole reason unknown onsets anchor at 12:00 rather than 00:00.
    for (const tz of ["Europe/London", "Europe/Vienna", "Europe/Berlin"]) {
      for (const d of ["2025-01-15", "2025-06-15", "2025-10-26"]) {
        const iso = zonedToUtcIso(d, 12, 0, tz);
        expect(iso.slice(0, 10)).toBe(d);
      }
    }
  });
});

describe("locationForDate", () => {
  it("maps the settled timeline", () => {
    expect(locationForDate("2024-08-28").tz).toBe("Europe/Vienna");
    expect(locationForDate("2025-03-01").tz).toBe("Europe/London");
    expect(locationForDate("2025-07-20").tz).toBe("Europe/Vienna");
    expect(locationForDate("2026-03-01").tz).toBe("Europe/Berlin");
    expect(locationForDate("2026-07-05").tz).toBe("Europe/Berlin");
  });

  it("flags dates adjacent to a boundary", () => {
    expect(locationForDate("2025-06-01").nearBoundary).toBe(true);
    expect(locationForDate("2025-03-01").nearBoundary).toBe(false);
  });
});

describe("sqlLit", () => {
  it("preserves spaces and newlines in notes", () => {
    expect(sqlLit("woke up with it, behind left eye")).toBe(
      "'woke up with it, behind left eye'"
    );
    expect(sqlLit("line one\nline two")).toBe("'line one\nline two'");
  });

  it("doubles single quotes", () => {
    expect(sqlLit("it's worse today")).toBe("'it''s worse today'");
  });

  it("emits NULL for empty and nullish", () => {
    expect(sqlLit("")).toBe("NULL");
    expect(sqlLit(null)).toBe("NULL");
    expect(sqlLit(undefined)).toBe("NULL");
  });

  it("strips NUL bytes", () => {
    expect(sqlLit("a\0b")).toBe("'ab'");
  });
});

describe("rowToEpisode", () => {
  const base = {
    date: "2025-03-10",
    severity: "7",
    level_start: "4",
    level_peak: "7",
    headache_type: "Left side - temple + eye",
    onset: "4:30pm",
    triggers: "Stress",
    triggers_canonical: "Stress; Not enough sleep",
    what_happened: "it's bad, behind the eye",
    next_time: "",
    source_file: "2025-03-10_Migraine.md",
  };

  it("quarantines self-reported fields and parses them into nothing", () => {
    const { episode } = rowToEpisode(base);
    expect(episode.self_reported_type).toBe("Left side - temple + eye");
    expect(episode.self_reported_triggers).toBe("Stress; Not enough sleep");
    // No side/quality/nausea is inferred from the messy old labels.
    expect(episode.side).toBeUndefined();
    expect(episode.quality).toBeUndefined();
    expect(episode.source).toBe("obsidian-import");
  });

  it("keeps the note verbatim", () => {
    const { episode } = rowToEpisode(base);
    expect(episode.note).toBe("it's bad, behind the eye");
  });

  it("resolves location and timezone from the date", () => {
    const { episode } = rowToEpisode(base);
    expect(episode.tz).toBe("Europe/London");
    expect(episode.started_at).toBe("2025-03-10T16:30:00.000Z"); // GMT in March
    expect(episode.started_at_time_known).toBe(1);
    expect(episode.local_date).toBe("2025-03-10");
  });

  it("marks unknown onset and anchors at local noon without shifting the day", () => {
    const { episode, warnings } = rowToEpisode({ ...base, onset: "morning" });
    expect(episode.started_at_time_known).toBe(0);
    expect(episode.local_date).toBe("2025-03-10");
    expect(episode.started_at.slice(0, 10)).toBe("2025-03-10");
    expect(episode.onset_raw).toBe("morning");
    expect(warnings.some((w: string) => w.includes("onset not parseable"))).toBe(true);
  });

  it("leaves duration null (history has no end times)", () => {
    const { episode } = rowToEpisode(base);
    expect(episode.ended_at).toBeNull();
  });

  it("emits start and peak severity samples, peak with unknown time", () => {
    const { samples } = rowToEpisode(base);
    expect(samples).toEqual([
      { kind: "start", ts: "2025-03-10T16:30:00.000Z", level: 4 },
      { kind: "peak", ts: null, level: 7 },
    ]);
  });

  it("falls back to severity as the peak when level_peak is missing", () => {
    const { samples } = rowToEpisode({ ...base, level_peak: "" });
    expect(samples).toContainEqual({ kind: "peak", ts: null, level: 7 });
  });

  it("rejects a bad date and an out-of-range severity", () => {
    expect(rowToEpisode({ ...base, date: "nonsense" }).episode).toBeNull();
    expect(rowToEpisode({ ...base, severity: "12" }).episode).toBeNull();
  });
});

describe("episodeToSql", () => {
  it("is idempotent: INSERT OR IGNORE keyed on source_file, samples guarded", () => {
    const mapped = rowToEpisode({
      date: "2025-03-10",
      severity: "7",
      level_start: "4",
      level_peak: "7",
      headache_type: "",
      onset: "4:30pm",
      triggers: "",
      triggers_canonical: "",
      what_happened: "note",
      next_time: "",
      source_file: "2025-03-10_Migraine.md",
    });
    const sql = episodeToSql(mapped);
    expect(sql).toContain("INSERT OR IGNORE INTO episodes");
    expect(sql).toContain("e.source_file = '2025-03-10_Migraine.md'");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM severity_samples");
    // no unqualified column that could bind to the wrong table
    expect(sql).not.toContain("WHERE e.source = 'obsidian-import' AND source_file");
  });
});

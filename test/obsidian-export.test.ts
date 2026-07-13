import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, TestD1 } from "./d1-adapter";
import { obsidianMarkdown } from "../src/worker/export";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const GEN = "2026-07-13T10:00:00.000Z";

let d1: TestD1;
beforeEach(() => {
  d1 = freshDb(migrationsDir).d1;
});

/** Parse the YAML frontmatter into a flat map (values stay strings). */
function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return Object.fromEntries(
    m[1].split("\n").map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
  );
}

describe("obsidianMarkdown", () => {
  it("writes a rollup frontmatter Dataview can read at page level", async () => {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, ended_at, local_date, started_at_time_known, source, severity)
         VALUES ('2026-03-02T08:00:00.000Z','2026-03-02T18:00:00.000Z','2026-03-02',1,'app',7)`
      )
      .run();
    const md = await obsidianMarkdown(d1, GEN);
    const fm = frontmatter(md);
    expect(fm.aura_snapshot).toBe("true");
    expect(fm.generated).toBe("2026-07-13");
    expect(fm.headache_days).toBe("1");
    expect(fm.migraine_days).toBe("0"); // no attributes recorded
  });

  it("separates headache days from migraine days and marks imported rows", async () => {
    // An app attack with a full migraine picture...
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, ended_at, local_date, started_at_time_known, source, severity,
                               side, quality, aggravated_by_activity, nausea)
         VALUES ('2026-03-02T08:00:00.000Z','2026-03-02T18:00:00.000Z','2026-03-02',1,'app',8,
                 'one','throbbing',1,1)`
      )
      .run();
    // ...and an imported diary row that must never be classified.
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, self_reported_type)
         VALUES ('2026-03-05T12:00:00.000Z','2026-03-05',0,'obsidian','migraine')`
      )
      .run();

    const md = await obsidianMarkdown(d1, GEN);
    expect(frontmatter(md).headache_days).toBe("2");
    expect(frontmatter(md).migraine_days).toBe("1");
    // The imported row appears but its assessment column is blank.
    const importedLine = md.split("\n").find((l) => l.startsWith("| 2026-03-05 |"));
    expect(importedLine).toContain("| obsidian |");
    expect(importedLine).not.toMatch(/migraine/);
    // The app attack is labelled migraine.
    const appLine = md.split("\n").find((l) => l.startsWith("| 2026-03-02 |"));
    expect(appLine).toMatch(/migraine/);
  });

  it("flags an estimated onset with a ~ and blanks duration for imported rows", async () => {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, ended_at, local_date, started_at_time_known, source)
         VALUES ('2026-04-01T09:00:00.000Z','2026-04-01T12:00:00.000Z','2026-04-01',0,'app')`
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source)
         VALUES ('2026-04-03T12:00:00.000Z','2026-04-03',0,'obsidian')`
      )
      .run();
    const md = await obsidianMarkdown(d1, GEN);
    const est = md.split("\n").find((l) => l.startsWith("| 2026-04-01 |"));
    expect(est).toContain("~3.0"); // ~ prefix on an estimated 3h duration
    expect(est).toContain("| ~ |"); // onset shown as ~ when unknown
    const imported = md.split("\n").find((l) => l.startsWith("| 2026-04-03 |"));
    // imported: no end time, so the duration cell is empty.
    expect(imported).toMatch(/\| 2026-04-03 \| ~ \|  \|/);
  });

  it("escapes pipes and newlines in notes so the table cannot break", async () => {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, note)
         VALUES ('2026-05-01T09:00:00.000Z','2026-05-01',1,'app',?)`
      )
      .bind("left | right\nsecond line")
      .run();
    const md = await obsidianMarkdown(d1, GEN);
    const line = md.split("\n").find((l) => l.startsWith("| 2026-05-01 |"));
    expect(line).toContain("left \\| right second line"); // pipe escaped, newline flattened
    // Exactly one physical row for the episode: the note did not add lines.
    expect(md.split("\n").filter((l) => l.startsWith("| 2026-05-01"))).toHaveLength(1);
  });

  it("produces a monthly table with a complete flag", async () => {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, source, severity)
         VALUES ('2026-06-10T09:00:00.000Z','2026-06-10',1,'app',5)`
      )
      .run();
    const md = await obsidianMarkdown(d1, GEN);
    expect(md).toContain("## Monthly headache days");
    expect(md).toMatch(/\| 2026-06 \| 1 \|/);
  });
});

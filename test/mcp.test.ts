import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import app from "../src/worker/index";
import { freshDb, TestD1 } from "./d1-adapter";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const PIN = "test-pin";

function env(d1: TestD1) {
  return { DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } } as never;
}

async function rpc(
  d1: TestD1,
  method: string,
  params?: Record<string, unknown>,
  opts: { token?: string; query?: string } = {}
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  const url = `/mcp${opts.query ?? ""}`;
  const res = await app.request(
    url,
    { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
    env(d1)
  );
  return res;
}

/** MCP tool results come back as a JSON string inside content[0].text. */
async function toolJson(res: Response) {
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return JSON.parse(body.result.content[0].text);
}

async function seed(d1: TestD1) {
  const rows: Array<[string, number | null, string | null, string | null, string]> = [
    ["2025-01-10", 6, "Stress; Not enough sleep", "woke up with it, behind left eye", "obsidian-import"],
    ["2025-01-20", 8, "Medication", "took sumatriptan at night", "obsidian-import"],
    ["2025-02-05", 4, "Late meal", "weather was bad today", "obsidian-import"],
  ];
  for (const [d, sev, trig, note, src] of rows) {
    await d1
      .prepare(
        `INSERT INTO episodes (started_at, local_date, started_at_time_known, ended_at,
                               severity, note, self_reported_triggers, source, source_file)
         VALUES (?, ?, 0, NULL, ?, ?, ?, ?, ?)`
      )
      .bind(`${d}T12:00:00.000Z`, d, sev, note, trig, src, `${d}.md`)
      .run();
  }
}

describe("MCP server", () => {
  let d1: TestD1;
  beforeEach(async () => {
    d1 = freshDb(migrationsDir).d1;
    await seed(d1);
  });

  it("rejects an unauthenticated call", async () => {
    const res = await rpc(d1, "initialize");
    expect(res.status).toBe(401);
  });

  it("accepts the PIN via a query token, for connectors that cannot set headers", async () => {
    const res = await rpc(d1, "initialize", undefined, { query: `?token=${PIN}` });
    expect(res.status).toBe(200);
  });

  it("initializes and advertises its tools", async () => {
    const init = (await (await rpc(d1, "initialize", undefined, { token: PIN })).json()) as {
      result: { serverInfo: { name: string }; protocolVersion: string };
    };
    expect(init.result.serverInfo.name).toBe("aura");
    expect(init.result.protocolVersion).toBe("2024-11-05");

    const list = (await (await rpc(d1, "tools/list", undefined, { token: PIN })).json()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("get_overview");
    expect(names).toContain("monthly_headache_days");
    expect(names).toContain("premonition_stats");
    expect(names).toContain("log_premonition");
  });

  it("get_overview reports headache days and carries the data caveats", async () => {
    const res = await rpc(d1, "tools/call", { name: "get_overview" }, { token: PIN });
    const out = await toolJson(res);
    expect(out.episodes).toBe(3);
    expect(out.headache_days).toBe(3);
    expect(out.imported).toBe(3);
    // The caveats travel with the data, because Claude narrates from them.
    expect(out.caveats).toContain("Monthly HEADACHE Days");
    expect(out.caveats).toContain("never diagnoses");
  });

  it("monthly_headache_days counts a day once, flags partial months, honours the range", async () => {
    const all = await toolJson(
      await rpc(d1, "tools/call", { name: "monthly_headache_days" }, { token: PIN })
    );
    // Seed spans 2025-01-10 .. 2025-02-05, so both months are only partly observed.
    expect(all).toEqual([
      { month: "2025-01", headache_days: 2, avg_severity: 7, complete: false },
      { month: "2025-02", headache_days: 1, avg_severity: 4, complete: false },
    ]);

    const jan = await toolJson(
      await rpc(
        d1,
        "tools/call",
        { name: "monthly_headache_days", arguments: { from: "2025-01-01", to: "2025-01-31" } },
        { token: PIN }
      )
    );
    expect(jan).toHaveLength(1);
    expect(jan[0].complete).toBe(true); // the explicit window covers the whole month
  });

  it("never invents migraine-free months after her last entry", async () => {
    // The seed ends 2025-02-05. Zero-filling to 'today' would manufacture more
    // than a year of fake headache-free months.
    const all = await toolJson(
      await rpc(d1, "tools/call", { name: "monthly_headache_days" }, { token: PIN })
    );
    expect(all.at(-1).month).toBe("2025-02");
  });

  it("search_notes finds the entry where she suspected the weather", async () => {
    const out = await toolJson(
      await rpc(d1, "tools/call", { name: "search_notes", arguments: { query: "weather" } }, { token: PIN })
    );
    expect(out.matches).toBe(1);
    expect(out.results[0].local_date).toBe("2025-02-05");
  });

  it("self_reported_triggers refuses to let beliefs pass as evidence", async () => {
    const out = await toolJson(
      await rpc(d1, "tools/call", { name: "self_reported_triggers" }, { token: PIN })
    );
    expect(out.triggers).toContainEqual({ trigger: "Stress", count: 1 });
    expect(out.triggers).toContainEqual({ trigger: "Medication", count: 1 });
    expect(out.warning).toContain("cannot establish causation");
    expect(out.warning).toContain("Do not present them as established triggers");
  });

  it("headache_days_trend refuses to compare quarters without enough months", async () => {
    const out = await toolJson(
      await rpc(d1, "tools/call", { name: "headache_days_trend" }, { token: PIN })
    );
    expect(out.enough_data).toBe(false);
  });

  it("log_premonition writes a timestamped row tagged as coming from MCP", async () => {
    const out = await toolJson(
      await rpc(
        d1,
        "tools/call",
        { name: "log_premonition", arguments: { note: "pressure behind the eyes", tz: "Europe/Berlin" } },
        { token: PIN }
      )
    );
    expect(out.logged.source).toBe("mcp");
    expect(out.logged.note).toBe("pressure behind the eyes");
    expect(out.logged.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const stats = await toolJson(
      await rpc(d1, "tools/call", { name: "premonition_stats" }, { token: PIN })
    );
    expect(stats.premonitions_eligible).toBe(1);
    expect(stats.enough_data).toBe(false); // one tap proves nothing
  });

  it("returns a tool error rather than crashing on an unknown tool", async () => {
    const res = await rpc(d1, "tools/call", { name: "nope" }, { token: PIN });
    const body = (await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Unknown tool");
  });

  it("does not let /mcp fall through to the SPA", async () => {
    const res = await app.request("/mcp", { headers: { Authorization: `Bearer ${PIN}` } }, env(d1));
    const body = (await res.json()) as { name: string; tools: string[] };
    expect(body.name).toBe("aura");
    expect(body.tools.length).toBeGreaterThan(5);
  });
});

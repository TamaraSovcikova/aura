import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app } from "../src/worker/index";
import { mcp } from "../src/worker/mcp";
import { freshDb, TestD1 } from "./d1-adapter";
import { checkPin } from "../src/worker/db";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const PIN = "test-pin";

let d1: TestD1;
beforeEach(() => {
  d1 = freshDb(migrationsDir).d1;
});

const withPin = () =>
  ({ DB: d1, ACCESS_PIN: PIN, ASSETS: { fetch: async () => new Response("") } }) as never;
// A deploy that forgot the secret: ACCESS_PIN is undefined.
const noPin = () =>
  ({ DB: d1, ACCESS_PIN: undefined, ASSETS: { fetch: async () => new Response("") } }) as never;

describe("checkPin — fail-closed access", () => {
  it("reports a misconfigured server when no PIN is set", () => {
    expect(checkPin(undefined, "Bearer anything")).toBe("misconfigured");
    expect(checkPin("", "Bearer anything")).toBe("misconfigured");
  });

  it("authorizes only the exact bearer token", () => {
    expect(checkPin(PIN, `Bearer ${PIN}`)).toBe("authorized");
    expect(checkPin(PIN, "Bearer wrong")).toBe("unauthorized");
    expect(checkPin(PIN, undefined)).toBe("unauthorized");
  });

  it("accepts a query token as a fallback (for header-less MCP connectors)", () => {
    expect(checkPin(PIN, undefined, PIN)).toBe("authorized");
    expect(checkPin(PIN, undefined, "wrong")).toBe("unauthorized");
  });
});

describe("REST guard", () => {
  it("refuses to serve health data (503) when the PIN is unset, not silently allow it", async () => {
    const res = await app.request("/api/summary", { headers: { Authorization: "Bearer x" } }, noPin());
    expect(res.status).toBe(503);
  });

  it("401s a wrong token and 200s the right one", async () => {
    const bad = await app.request("/api/summary", { headers: { Authorization: "Bearer nope" } }, withPin());
    expect(bad.status).toBe(401);
    const good = await app.request("/api/summary", { headers: { Authorization: `Bearer ${PIN}` } }, withPin());
    expect(good.status).toBe(200);
  });

  it("keeps /api/health public for uptime checks even with no PIN", async () => {
    const res = await app.request("/api/health", {}, noPin());
    expect(res.status).toBe(200);
  });
});

describe("MCP guard", () => {
  const call = (env: never, headers: Record<string, string> = {}) =>
    mcp.request(
      "/",
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
      env
    );

  it("returns 503 when the PIN is unset rather than exposing the tools", async () => {
    const res = await call(noPin());
    expect(res.status).toBe(503);
  });

  it("401s without a token and 200s with the right one", async () => {
    expect((await call(withPin())).status).toBe(401);
    expect((await call(withPin(), { Authorization: `Bearer ${PIN}` })).status).toBe(200);
  });
});

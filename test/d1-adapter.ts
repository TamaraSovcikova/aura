// Minimal D1Database adapter over Node's built-in node:sqlite (Node 22.5+).
// Executes real SQL against an in-memory database so tests genuinely exercise
// the routes and schema, no query-result mocking.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// node:sqlite is a very new builtin Vite's resolver doesn't know about, so
// require it at runtime to bypass static resolution.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;

type Row = Record<string, unknown>;

function clean(args: unknown[]): unknown[] {
  // node:sqlite rejects `undefined` and booleans; coerce to null / 0|1.
  return args.map((a) =>
    a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a
  );
}

class Stmt {
  private args: unknown[] = [];
  constructor(private db: Db, private sql: string) {}
  bind(...args: unknown[]) {
    this.args = clean(args);
    return this;
  }
  async first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return (row as T) ?? null;
  }
  async all<T = Row>(): Promise<{ results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[]));
    return { results: rows as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true, meta: r };
  }
}

export class TestD1 {
  constructor(private db: Db) {}
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

export function freshDb(migrationsDir: string): { raw: Db; d1: TestD1 } {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  return { raw: db, d1: new TestD1(db) };
}

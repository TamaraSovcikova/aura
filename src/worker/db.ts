import type { Context } from "hono";

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  // Shared PIN. Client sends `Authorization: Bearer <ACCESS_PIN>`. When unset,
  // the Worker allows all requests (local dev convenience).
  ACCESS_PIN: string | undefined;
};

export type AppContext = Context<{ Bindings: Bindings }>;

export const nowIso = () => new Date().toISOString();

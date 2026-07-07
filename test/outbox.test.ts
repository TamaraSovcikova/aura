import { describe, it, expect, vi } from "vitest";
import { reconcile, type LocalEpisode } from "../src/client/outbox";

function rec(over: Partial<LocalEpisode> = {}): LocalEpisode {
  return {
    localId: "l1",
    serverId: null,
    started_at: "2026-07-07T10:00:00.000Z",
    ended_at: null,
    lat: null,
    lon: null,
    tz: null,
    severity: null,
    meds: null,
    note: null,
    startedSynced: false,
    endedSynced: false,
    ...over,
  };
}

describe("outbox reconcile", () => {
  it("syncs a completed episode once and drops it", async () => {
    const start = vi.fn(async () => 7);
    const end = vi.fn(async () => {});
    const out = await reconcile(
      [rec({ ended_at: "2026-07-07T11:00:00.000Z" })],
      start,
      end
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });

  it("keeps an ongoing episode after syncing its start", async () => {
    const start = vi.fn(async () => 9);
    const end = vi.fn(async () => {});
    const out = await reconcile([rec()], start, end);
    expect(out).toHaveLength(1);
    expect(out[0].serverId).toBe(9);
    expect(out[0].startedSynced).toBe(true);
    expect(end).not.toHaveBeenCalled();
  });

  it("never re-POSTs a start on a repeat sync (no duplicate rows)", async () => {
    const start = vi.fn(async () => 5);
    const end = vi.fn(async () => {});
    let list = await reconcile([rec()], start, end);
    list = await reconcile(list, start, end);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("retains the record when the network fails", async () => {
    const start = vi.fn(async () => {
      throw new Error("network down");
    });
    const end = vi.fn(async () => {});
    const out = await reconcile([rec()], start, end);
    expect(out).toHaveLength(1);
    expect(out[0].startedSynced).toBe(false);
  });

  it("rethrows auth errors so the UI can re-prompt", async () => {
    const authErr = Object.assign(new Error("unauthorized"), {
      name: "UnauthorizedError",
    });
    const start = vi.fn(async () => {
      throw authErr;
    });
    const end = vi.fn(async () => {});
    await expect(reconcile([rec()], start, end)).rejects.toThrow("unauthorized");
  });
});

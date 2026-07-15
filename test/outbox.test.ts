import { describe, it, expect, vi } from "vitest";
import { reconcile, newLocalDose, type LocalEpisode, type LocalDose } from "../src/client/outbox";

function rec(over: Partial<LocalEpisode> = {}): LocalEpisode {
  return {
    localId: "l1",
    serverId: null,
    started_at: "2026-07-07T10:00:00.000Z",
    ended_at: null,
    time_known: true,
    lat: null,
    lon: null,
    tz: null,
    severity: null,
    meds: null,
    note: null,
    attrs: null,
    doses: [],
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

describe("outbox reconcile — medication doses", () => {
  const dose = (over: Partial<LocalDose> = {}): LocalDose => ({
    ...newLocalDose({ name: "Sumatriptan", taken_at: "2026-07-07T10:30:00.000Z" }),
    ...over,
  });

  it("POSTs a dose once the episode has a server id, then keeps the record", async () => {
    const start = vi.fn(async () => 42);
    const end = vi.fn(async () => {});
    const doseFn = vi.fn(async () => 100);
    const reliefFn = vi.fn(async () => {});
    const out = await reconcile([rec({ doses: [dose()] })], start, end, doseFn, reliefFn);
    expect(doseFn).toHaveBeenCalledWith(42, {
      name: "Sumatriptan",
      client_taken_at: "2026-07-07T10:30:00.000Z",
    });
    // Ongoing episode with a synced dose is retained; the dose is not re-POSTed.
    expect(out).toHaveLength(1);
    expect(out[0].doses[0].takenSynced).toBe(true);
    expect(out[0].doses[0].serverId).toBe(100);
  });

  it("does not re-POST a dose on a second sync", async () => {
    const start = vi.fn(async () => 42);
    const end = vi.fn(async () => {});
    const doseFn = vi.fn(async () => 100);
    const reliefFn = vi.fn(async () => {});
    let list = await reconcile([rec({ doses: [dose()] })], start, end, doseFn, reliefFn);
    list = await reconcile(list, start, end, doseFn, reliefFn);
    expect(doseFn).toHaveBeenCalledTimes(1);
  });

  it("POSTs relief only after the dose, and drops a fully-synced ended episode", async () => {
    const start = vi.fn(async () => 42);
    const end = vi.fn(async () => {});
    const doseFn = vi.fn(async () => 100);
    const reliefFn = vi.fn(async () => {});
    const out = await reconcile(
      [
        rec({
          ended_at: "2026-07-07T12:00:00.000Z",
          doses: [
            dose({ relief_at: "2026-07-07T11:00:00.000Z", relief_severity: 2 }),
          ],
        }),
      ],
      start,
      end,
      doseFn,
      reliefFn
    );
    expect(doseFn).toHaveBeenCalledTimes(1);
    expect(reliefFn).toHaveBeenCalledWith(100, {
      relief_severity: 2,
      client_relief_at: "2026-07-07T11:00:00.000Z",
    });
    expect(out).toEqual([]);
  });

  it("retains an ended episode whose dose has not synced yet", async () => {
    const start = vi.fn(async () => 42);
    const end = vi.fn(async () => {});
    const doseFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const reliefFn = vi.fn(async () => {});
    const out = await reconcile(
      [rec({ ended_at: "2026-07-07T12:00:00.000Z", doses: [dose()] })],
      start,
      end,
      doseFn,
      reliefFn
    );
    expect(out).toHaveLength(1);
    expect(out[0].doses[0].takenSynced).toBe(false);
  });
});

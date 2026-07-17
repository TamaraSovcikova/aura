// @vitest-environment happy-dom
//
// The outbox is a PERSISTED schema: records written by an older build of the app
// survive in localStorage across a deploy. Every field added since is therefore
// optional in the wild, and code that dereferences one without a default will
// crash on a record that predates it.
//
// This happened for real: the medication feature added `doses`, MedPanel did
// [...open.doses], and an attack still queued from the previous build took the
// whole screen blank AND kept it blank, because the bad record reloads every time.
//
// These lock the rule: loadOutbox() returns records in the CURRENT shape, whatever
// shape they were stored in.

import { describe, it, expect, beforeEach } from "vitest";
import { loadOutbox, reconcile, saveOutbox, type LocalEpisode } from "../src/client/outbox";

/** Exactly what the pre-medication build wrote: no `doses`, no `attrs`. */
const OLD_SHAPE_RECORD = {
  localId: "old-1",
  serverId: 12,
  started_at: "2026-07-15T10:00:00.000Z",
  ended_at: null,
  time_known: true,
  lat: null,
  lon: null,
  tz: "Europe/Berlin",
  severity: null,
  meds: null,
  note: null,
  startedSynced: true,
  endedSynced: false,
};

describe("loadOutbox normalises records written by older builds", () => {
  beforeEach(() => localStorage.clear());

  it("gives a record with no `doses` an empty array", () => {
    localStorage.setItem("aura_outbox", JSON.stringify([OLD_SHAPE_RECORD]));
    const [rec] = loadOutbox();
    expect(rec.doses).toEqual([]);
  });

  it("defaults `attrs` and `time_known` rather than leaving them undefined", () => {
    localStorage.setItem("aura_outbox", JSON.stringify([OLD_SHAPE_RECORD]));
    const [rec] = loadOutbox();
    expect(rec.attrs).toBeNull();
    expect(rec.time_known).toBe(true);
  });

  it("keeps a stored `doses` array intact and repairs a non-array one", () => {
    localStorage.setItem(
      "aura_outbox",
      JSON.stringify([
        { ...OLD_SHAPE_RECORD, localId: "a", doses: [{ localId: "d1", taken_at: "x" }] },
        { ...OLD_SHAPE_RECORD, localId: "b", doses: "corrupt" },
      ])
    );
    const list = loadOutbox();
    expect(list[0].doses).toHaveLength(1);
    expect(list[1].doses).toEqual([]);
  });

  it("drops entries that are not objects instead of returning them", () => {
    localStorage.setItem("aura_outbox", JSON.stringify([OLD_SHAPE_RECORD, null, "junk", 7]));
    expect(loadOutbox()).toHaveLength(1);
  });

  it("survives a round-trip through saveOutbox", () => {
    localStorage.setItem("aura_outbox", JSON.stringify([OLD_SHAPE_RECORD]));
    const list = loadOutbox();
    saveOutbox(list);
    expect(loadOutbox()[0].doses).toEqual([]);
  });
});

describe("reconcile tolerates a record from an older build", () => {
  const start = async () => 12;
  const end = async () => {};
  const dose = async () => 1;
  const relief = async () => {};

  it("does not throw when `doses` is missing on an already-synced record", async () => {
    // Simulates the raw record reaching reconcile without going through loadOutbox.
    const raw = { ...OLD_SHAPE_RECORD, ended_at: "2026-07-15T12:00:00.000Z" } as unknown as LocalEpisode;
    await expect(reconcile([raw], start, end, dose, relief)).resolves.toBeDefined();
  });

  it("still syncs and drops an old-shape record instead of retaining it forever", async () => {
    const raw = { ...OLD_SHAPE_RECORD, ended_at: "2026-07-15T12:00:00.000Z" } as unknown as LocalEpisode;
    // Fully synced with no doses to send: it must not be kept for a retry that can
    // never succeed (the old bug swallowed a TypeError and kept it every pass).
    await expect(reconcile([raw], start, end, dose, relief)).resolves.toEqual([]);
  });

  it("does not throw when `doses` is missing on a not-yet-synced record", async () => {
    // serverId null skips the dose block entirely, so the unguarded drop check on
    // e.doses.every() is reached directly and throws out of reconcile.
    const raw = {
      ...OLD_SHAPE_RECORD,
      serverId: null,
      startedSynced: false,
      ended_at: "2026-07-15T12:00:00.000Z",
    } as unknown as LocalEpisode;
    await expect(reconcile([raw], start, end, dose, relief)).resolves.toBeDefined();
  });
});

// @vitest-environment happy-dom
//
// The log is the surface she scans. A row has to say what an attack WAS and what was
// done about it without lying: an imported diary row carries no symptoms and must
// never be labelled, and a medication summary must not claim relief that was not
// recorded.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import History from "../src/client/History";
import type { Episode } from "../src/shared/types";

const base: Episode = {
  id: 1,
  user_id: null,
  started_at: "2026-07-15T07:21:00.000Z",
  local_date: "2026-07-15",
  started_at_time_known: 1,
  ended_at: "2026-07-15T13:23:00.000Z",
  severity: 6,
  meds: null,
  note: null,
  weather_code: null,
  pressure_hpa: null,
  temp_c: null,
  lat: null,
  lon: null,
  tz: "UTC",
  created_at: "",
  updated_at: "",
  source: "app",
};

const ep = (over: Partial<Episode>): Episode => ({ ...base, ...over });

describe("History rows", () => {
  it("shows both times and the duration, not just the start", () => {
    render(<History episodes={[ep({})]} onSelect={() => {}} />);
    const row = screen.getByRole("button");
    expect(row.textContent).toMatch(/→/);
    expect(row.textContent).toMatch(/6h 2m/);
  });

  it("labels a described attack with the criteria it meets", () => {
    render(
      <History
        episodes={[
          ep({
            id: 2,
            // Unilateral, throbbing, aggravated, with nausea and photophobia.
            side: "one",
            quality: "throbbing",
            aggravated_by_activity: 1,
            nausea: 1,
            photophobia: 1,
            phonophobia: 0,
            aura: 0,
          }),
        ]}
        onSelect={() => {}}
      />
    );
    expect(screen.getByRole("button").textContent).toMatch(/migraine/);
  });

  it("never labels an imported row, which carries no symptoms to judge", () => {
    render(
      <History
        episodes={[ep({ id: 3, source: "obsidian", ended_at: null })]}
        onSelect={() => {}}
      />
    );
    const row = screen.getByRole("button");
    expect(row.textContent).toMatch(/imported/);
    expect(row.textContent).not.toMatch(/migraine|tension/);
    // No end time recorded is "unknown", not "ongoing".
    expect(row.textContent).toMatch(/unknown/);
  });

  it("summarises doses and only claims relief when relief was recorded", () => {
    render(
      <History
        episodes={[
          ep({ id: 4, dose_count: 2, dose_relief_count: 1 }),
          ep({ id: 5, started_at: "2026-07-14T08:00:00.000Z", dose_count: 1, dose_relief_count: 0 }),
        ]}
        onSelect={() => {}}
      />
    );
    const rows = screen.getAllByRole("button");
    expect(rows[0].textContent).toMatch(/2 doses, helped/);
    expect(rows[1].textContent).toMatch(/1 dose/);
    expect(rows[1].textContent).not.toMatch(/helped/);
  });

  it("still reports legacy free-text medication when there are no doses", () => {
    render(
      <History episodes={[ep({ id: 6, meds: "sumatriptan 50mg" })]} onSelect={() => {}} />
    );
    expect(screen.getByRole("button").textContent).toMatch(/medication/);
  });

  it("marks an estimated onset on the time, and groups by month", () => {
    render(
      <History
        episodes={[
          ep({ id: 7, started_at_time_known: 0 }),
          ep({ id: 8, started_at: "2026-06-02T09:00:00.000Z", ended_at: "2026-06-02T11:00:00.000Z" }),
        ]}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText(/July 2026/)).toBeInTheDocument();
    expect(screen.getByText(/June 2026/)).toBeInTheDocument();
    expect(screen.getAllByRole("button")[0].textContent).toMatch(/~/);
  });

  it("opens an entry when tapped", () => {
    const onSelect = vi.fn();
    render(<History episodes={[ep({})]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("says so plainly when there is nothing logged", () => {
    render(<History episodes={[]} onSelect={() => {}} />);
    expect(screen.getByText(/Nothing logged yet/)).toBeInTheDocument();
  });
});

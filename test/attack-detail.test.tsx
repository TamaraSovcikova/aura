// @vitest-environment happy-dom
//
// The read-only attack view. It must show what was recorded and nothing more: the
// doses and the relief they brought on the timeline, and no timeline at all for an
// imported row that never had an end time.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AttackDetail from "../src/client/AttackDetail";
import type { Episode, MedDose } from "../src/shared/types";

const base: Episode = {
  id: 1,
  user_id: null,
  started_at: "2026-07-15T07:00:00.000Z",
  local_date: "2026-07-15",
  started_at_time_known: 1,
  ended_at: "2026-07-15T13:00:00.000Z",
  severity: 7,
  meds: null,
  note: "behind the eye",
  weather_code: null,
  pressure_hpa: null,
  temp_c: null,
  lat: null,
  lon: null,
  tz: "UTC",
  created_at: "",
  updated_at: "",
  source: "app",
  pain_regions: JSON.stringify(["l-eye"]),
  nausea: 1,
  photophobia: 0,
};

const dose: MedDose = {
  id: 11,
  episode_id: 1,
  name: "ibuprofen",
  taken_at: "2026-07-15T08:00:00.000Z",
  relief_at: "2026-07-15T09:30:00.000Z",
  relief_severity: 2,
  created_at: "",
};

describe("AttackDetail", () => {
  it("summarises the attack and places the dose and its relief on the timeline", () => {
    render(<AttackDetail episode={base} doses={[dose]} onEdit={() => {}} onClose={() => {}} />);
    expect(screen.getByText("7/10")).toBeInTheDocument();
    expect(screen.getByText("dose, 1 helped")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Attack timeline" })).toBeInTheDocument();
    expect(screen.getByText(/ibuprofen/)).toBeInTheDocument();
    expect(screen.getByText("relief, 2/10")).toBeInTheDocument();
    // Only recorded symptoms appear: nausea yes, light explicitly no.
    expect(screen.getByText("Nausea")).toBeInTheDocument();
    expect(screen.queryByText("Light hurt")).toBeNull();
    expect(screen.getByText("behind the eye")).toBeInTheDocument();
  });

  it("draws no timeline for an imported row with no end time", () => {
    render(
      <AttackDetail
        episode={{ ...base, source: "obsidian-import", ended_at: null }}
        doses={[]}
        onEdit={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.queryByRole("img", { name: "Attack timeline" })).toBeNull();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("hands the entry to the editor", () => {
    const onEdit = vi.fn();
    render(<AttackDetail episode={base} doses={[]} onEdit={onEdit} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
//
// The stateful client components were only ever checked by hand in the browser. The
// head map (paint -> derived side) and the symptom panel (tri-state, where "not
// recorded" must stay distinct from "no") both feed the ICHD-3 classifier, so a
// regression here silently changes migraine counts. These lock the behavior.

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import HeadMap from "../src/client/HeadMap";
import SymptomDetails, { type Attrs, emptyAttrs } from "../src/client/SymptomDetails";

function HeadMapHarness() {
  const [v, setV] = useState<string[]>([]);
  return <HeadMap value={v} onChange={setV} />;
}

describe("HeadMap", () => {
  it("derives one-sided from left-only regions and both from opposite sides", () => {
    render(<HeadMapHarness />);
    expect(screen.getByText("Tap where it hurts")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Left temple" }));
    expect(screen.getByText("One-sided")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Right temple" }));
    expect(screen.getByText("Both sides / central")).toBeInTheDocument();
  });

  it("toggles a region off when tapped again", () => {
    render(<HeadMapHarness />);
    const region = screen.getByRole("button", { name: "Behind left eye" });
    fireEvent.click(region);
    expect(region).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(region);
    expect(region).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Tap where it hurts")).toBeInTheDocument();
  });

  it("treats a midline-only selection as central, not one-sided", () => {
    render(<HeadMapHarness />);
    // Both views are drawn at once; the midline regions (crown, neck) are on the back.
    fireEvent.click(screen.getByRole("button", { name: "Top of head" }));
    expect(screen.getByText("Both sides / central")).toBeInTheDocument();
  });
});

let latestAttrs: Attrs = emptyAttrs();
function SymptomHarness() {
  const [a, setA] = useState<Attrs>(emptyAttrs());
  latestAttrs = a;
  return <SymptomDetails value={a} onChange={setA} />;
}

const rowButton = (question: string, answer: string) =>
  within(screen.getByRole("group", { name: question })).getByRole("button", { name: answer });

describe("SymptomDetails tri-state", () => {
  it("keeps 'not recorded' (null) distinct from 'no' (false)", () => {
    latestAttrs = emptyAttrs();
    render(<SymptomHarness />);
    // Default: nothing recorded.
    expect(latestAttrs.nausea).toBeNull();

    fireEvent.click(rowButton("Nausea", "Yes"));
    expect(latestAttrs.nausea).toBe(true);

    fireEvent.click(rowButton("Nausea", "No"));
    expect(latestAttrs.nausea).toBe(false); // an explicit no, which the classifier uses
    expect(rowButton("Nausea", "No")).toHaveAttribute("aria-pressed", "true");

    // Tapping the active choice again clears it back to unrecorded.
    fireEvent.click(rowButton("Nausea", "No"));
    expect(latestAttrs.nausea).toBeNull();
  });

  it("records pain quality and the head map into the same attrs object", () => {
    latestAttrs = emptyAttrs();
    render(<SymptomHarness />);
    fireEvent.click(rowButton("The pain was", "Throbbing"));
    fireEvent.click(screen.getByRole("button", { name: "Left temple" }));
    expect(latestAttrs.quality).toBe("throbbing");
    expect(latestAttrs.pain_regions).toEqual(["l-temple"]);
  });
});

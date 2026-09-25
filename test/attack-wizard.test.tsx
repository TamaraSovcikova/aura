// @vitest-environment happy-dom
//
// The "How was it?" walkthrough. What matters: every page can be skipped, "Not sure"
// is stored as unknown (null) and never as a no, one-answer pages move on by
// themselves, and closing early keeps what was already answered.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import AttackWizard from "../src/client/AttackWizard";
import type { AttackDraft } from "../src/client/AttackSheet";
import { emptyAttrs } from "../src/client/SymptomDetails";

const initial: AttackDraft = {
  started_at: "2026-07-15T07:00:00.000Z",
  started_at_time_known: true,
  ended_at: "2026-07-15T13:00:00.000Z",
  severity: null,
  note: "",
  attrs: emptyAttrs(),
};

function setup() {
  const onSave = vi.fn();
  render(
    <AttackWizard
      initial={initial}
      doses={[]}
      onSave={onSave}
      onCancel={() => {}}
      onAddDose={() => {}}
      onLogRelief={() => {}}
      onDeleteDose={() => {}}
    />
  );
  return onSave;
}

const heading = () => screen.getByRole("heading").textContent;
const tick = () => act(() => vi.advanceTimersByTime(400));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("AttackWizard", () => {
  it("asks one question per page and moves on after a single answer", () => {
    setup();
    expect(heading()).toBe("How bad was it at its worst?");
    fireEvent.click(screen.getByRole("button", { name: /Moderate/ }));
    tick();
    expect(heading()).toBe("Where did it hurt?");
  });

  it("stores 'Not sure' as unknown, never as no", () => {
    const onSave = setup();
    fireEvent.click(screen.getByRole("button", { name: "Not sure" })); // severity
    tick();
    fireEvent.click(screen.getByRole("button", { name: "Skip" })); // where
    fireEvent.click(screen.getByRole("button", { name: "Not sure" })); // quality
    tick();
    const nausea = screen.getByRole("group", { name: "Nausea" });
    fireEvent.click(within(nausea).getByRole("button", { name: "Not sure" }));
    const light = screen.getByRole("group", { name: "Light bothered you" });
    fireEvent.click(within(light).getByRole("button", { name: "No" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));

    const saved = onSave.mock.calls[0][0] as AttackDraft;
    expect(saved.severity).toBeNull();
    expect(saved.attrs.quality).toBeNull();
    expect(saved.attrs.nausea).toBeNull(); // not sure: unknown
    expect(saved.attrs.photophobia).toBe(false); // an explicit no stays a no
  });

  it("labels the forward button Skip until the page is answered", () => {
    setup();
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "Exact severity" }), { target: { value: "7" } });
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  it("keeps what was answered when closed early", () => {
    const onSave = setup();
    fireEvent.click(screen.getByRole("button", { name: /Severe/ }));
    tick();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect((onSave.mock.calls[0][0] as AttackDraft).severity).toBe(9);
  });

  it("ends on a review that jumps back to any answer", () => {
    setup();
    for (let n = 0; n < 5; n++) fireEvent.click(screen.getByRole("button", { name: /Skip|Next/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(heading()).toBe("Check and save");
    fireEvent.click(screen.getByRole("button", { name: /Worst/ }));
    expect(heading()).toBe("How bad was it at its worst?");
  });
});

// @vitest-environment happy-dom
//
// A render error used to unmount the app and leave a blank screen that came back on
// every reload. This locks the escape hatch: the error is shown, and the destructive
// recovery says what it will cost before it costs it.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ErrorBoundary from "../src/client/ErrorBoundary";

function Boom(): never {
  throw new Error("doses is not iterable");
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    localStorage.clear();
    // React logs the caught error; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("shows the failure and the message instead of a blank screen", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText("Aura hit a problem")).toBeInTheDocument();
    expect(screen.getByText("doses is not iterable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("warns how many unsent records a reset would discard", () => {
    localStorage.setItem(
      "aura_outbox",
      JSON.stringify([
        { localId: "a", started_at: "2026-07-15T10:00:00.000Z" },
        { localId: "b", started_at: "2026-07-15T11:00:00.000Z" },
      ])
    );
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText(/2 records not yet sent/)).toBeInTheDocument();
  });

  it("says a reset is safe when nothing is queued", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText(/nothing is currently waiting to be sent/)).toBeInTheDocument();
  });

  it("copies the queue out before clearing it, so nothing is lost silently", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload },
      configurable: true,
    });
    localStorage.setItem(
      "aura_outbox",
      JSON.stringify([{ localId: "a", started_at: "2026-07-15T10:00:00.000Z" }])
    );

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy and clear local data" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    // The copied payload carries the record; only then is it removed.
    expect(String(writeText.mock.calls[0][0])).toContain("localId");
    expect(localStorage.getItem("aura_outbox")).toBeNull();
    expect(reload).toHaveBeenCalled();
  });
});

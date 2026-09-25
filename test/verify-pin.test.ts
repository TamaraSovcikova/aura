// A PIN is checked before it is accepted. Without this, a wrong PIN opened the app
// (the first calls treat failures as offline) and then bounced back to the PIN
// screen with no message as soon as a tab made an authorised call.

import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyPin } from "../src/client/api";

afterEach(() => vi.unstubAllGlobals());

describe("verifyPin", () => {
  it("reports a wrong PIN when the server answers 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await verifyPin("nope")).toBe("wrong");
  });

  it("accepts a PIN the server accepts, sending it as the bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response("null", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyPin("right")).toBe("ok");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer right");
  });

  it("cannot tell when offline, so it does not call the PIN wrong", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await verifyPin("maybe")).toBe("offline");
  });
});

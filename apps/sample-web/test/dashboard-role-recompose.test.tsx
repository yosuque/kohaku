import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRole } from "../src/kohaku/role.js";
import { DashboardPage } from "../src/pages/DashboardPage.js";
import { ThemeModeProvider } from "../src/theme/mode.js";

/**
 * Regression test for DashboardPage's role-driven re-compose. The capability a compose returns is issued to the
 * principal of the role that composed, and that principal is the requester of every governed action on the
 * surface (the Demo 5 approval flow). So switching the role must compose again, as the new role, or the page
 * would keep acting as the old one.
 */

interface ComposeCall {
  url: string;
  headers: Record<string, string>;
}

/** Records every request and never answers: only the request itself is under test, not the rendered result. */
function stubPendingFetch(): ComposeCall[] {
  const calls: ComposeCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return new Promise<Response>(() => {});
    }),
  );
  return calls;
}

describe("DashboardPage re-composes when the role changes", () => {
  beforeEach(() => {
    // jsdom does not implement matchMedia; ThemeModeProvider's initial-mode detection needs a stub.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }),
    );
    // Node's built-in `localStorage` global shadows jsdom's in this Vitest/Node combination (see
    // latest-request.test.tsx), so an in-memory stand-in is installed for ThemeModeProvider and role.ts.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    });
  });
  afterEach(() => {
    act(() => setRole("admin"));
    vi.unstubAllGlobals();
  });

  it("composes again, carrying the new role, after setRole('viewer')", async () => {
    const calls = stubPendingFetch();
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    // The mount-time compose runs as the default (admin: no role header).
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain("/compose");
    expect(calls[0]!.headers["x-kohaku-role"]).toBeUndefined();

    act(() => setRole("viewer"));

    // The role change triggers a second compose, as the viewer.
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.url).toContain("/compose");
    expect(calls[1]!.headers["x-kohaku-role"]).toBe("viewer");
  });
});

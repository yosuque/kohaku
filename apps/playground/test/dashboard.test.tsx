// @vitest-environment jsdom
import { App, ThemeModeProvider } from "@kohaku-ui-sample/web/app";
import { render, screen } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlaygroundHost } from "../src/host/create-host.js";
import { installFetchShim } from "../src/host/fetch-shim.js";

/**
 * Renders sample-web's real, unforked `App` (its "./app" export) under a `HashRouter` — exactly how
 * `main.tsx` mounts it — against a real playground host reached only through the fetch shim, and confirms
 * the Dashboard's default view (an L0 fixed spec, `sales.quarterly_summary`) actually composes and renders.
 * No LLM fixture is needed: L0 never calls the LLM at all.
 */
describe("the Dashboard's default L0 view composes through the fetch shim and renders", () => {
  let restoreShim: (() => void) | undefined;

  beforeEach(() => {
    // jsdom implements neither matchMedia (ThemeModeProvider's initial-mode detection) nor ResizeObserver
    // (recharts' ResponsiveContainer, used by the quarterly_summary view's chart) — same pattern as
    // sample-web's own test/admin-page.test.tsx.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    // Node's built-in `localStorage` global shadows jsdom's Storage in this Vitest/Node combination;
    // ThemeModeProvider / role.ts / tenant.ts all call it unguarded (same pattern as admin-page.test.tsx).
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    });
  });

  afterEach(() => {
    restoreShim?.();
    restoreShim = undefined;
    vi.unstubAllGlobals();
  });

  it("shows the L0 provenance tier once the default view has composed via the shim", async () => {
    const host = await createPlaygroundHost();
    restoreShim = installFetchShim(() => host.app, { origin: window.location.origin });

    render(
      <ThemeModeProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </ThemeModeProvider>,
    );

    // ProvenanceBadge renders spec.provenance.tier as its own text node — "L0" appears only once the
    // real compose round trip (App -> DashboardPage -> kohaku/client.ts -> shimmed fetch -> host.app.fetch
    // -> host-rest -> composer's L0 fixed-spec path) has actually completed.
    const badge = await screen.findByText("L0");
    expect(badge.textContent).toBe("L0");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n/lang.js";
import { t as dict, UI } from "../src/i18n/ui.js";
import { AdminPage } from "../src/pages/AdminPage.js";
import { ThemeModeProvider } from "../src/theme/mode.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * A fetch stub matching on method + a URL substring (not `endsWith`, since GET /lineage carries a
 * `?limit=` querystring appended by useLineage's default query). Every call not covered by `handlers`
 * throws, so an unexpected request fails the test loudly instead of hanging.
 */
function stubFetch(handlers: Record<string, () => Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const key = Object.keys(handlers).find(
        (k) => k.startsWith(`${method} `) && url.includes(k.slice(method.length + 1)),
      );
      if (key == null) throw new Error(`unhandled fetch: ${method} ${url}`);
      return handlers[key]!();
    }),
  );
}

describe("AdminPage (thin wrapper over @kohaku-ui/admin-react)", () => {
  beforeEach(() => {
    // jsdom does not implement matchMedia; ThemeModeProvider's initial-mode detection needs a stub
    // (same pattern as latest-request.test.tsx).
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }),
    );
    // Node's built-in `localStorage` global shadows jsdom's Storage implementation in this Vitest/Node
    // combination; ThemeModeProvider.initialMode() calls it unguarded, so it needs a minimal in-memory stub.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => void store.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setLang("en");
  });

  it("passes the JA dictionary and the bump toolbar", async () => {
    stubFetch({ "GET /lineage": () => jsonResponse({ events: [] }) });
    setLang("ja");
    render(
      <ThemeModeProvider>
        <AdminPage />
      </ThemeModeProvider>,
    );
    await screen.findByText(UI.ja.admin.lineage.empty);
    expect(screen.getByText(UI.ja.admin.bumpButton)).toBeTruthy();
    expect(screen.getByText(UI.ja.admin.tabPromotions)).toBeTruthy();
  });

  /**
   * Proves the wiring, not just promotion-defaults.ts in isolation: renders the real AdminPage, switches to
   * the real Promotions tab, and asserts on a value only `salesPromotionDefaults` can produce for this
   * candidate — `genericInitialDraft` always leaves `componentType` empty, so a passing assertion here is
   * proof that `promotionDefaults={salesPromotionDefaults}` actually reached KohakuAdmin/PromotionsTab.
   * (A prior version of this test called `salesPromotionDefaults.initialDraftFor` directly without rendering
   * AdminPage at all, so it kept passing even with `promotionDefaults` deleted from AdminPage.tsx — see
   * task-8-report.md's "Fix round 1" for the mutation that caught this.)
   */
  it("wires the sales promotion defaults through to the rendered Promotions tab", async () => {
    const candidate = {
      artifactId: "sales.calendarHeatmap@1",
      status: "candidate",
      request: "Show sales as a calendar heatmap",
      uses: 5,
      sessions: 4,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    stubFetch({
      "GET /lineage": () => jsonResponse({ events: [] }),
      "GET /analytics/summary": () =>
        jsonResponse({ promotionPolicy: { promotionMinUses: 2, fixationMinUses: 3 } }),
      "GET /promotions": () => jsonResponse({ candidates: [candidate] }),
    });
    render(
      <ThemeModeProvider>
        <AdminPage />
      </ThemeModeProvider>,
    );
    fireEvent.click(screen.getByText(dict().admin.tabPromotions));
    await screen.findByText(candidate.artifactId);

    const componentTypeInput = screen.getByLabelText("componentType") as HTMLInputElement;
    expect(componentTypeInput.value).toBe("sales.calendarHeatmap");
  });
});

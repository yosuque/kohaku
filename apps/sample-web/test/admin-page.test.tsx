import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n/lang.js";
import { UI } from "../src/i18n/ui.js";
import { AdminPage } from "../src/pages/AdminPage.js";
import { salesPromotionDefaults } from "../src/pages/admin/promotion-defaults.js";
import { ThemeModeProvider } from "../src/theme/mode.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ events: [] })),
    );
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

  it("sales promotion defaults prefill the heatmap draft", () => {
    const d = salesPromotionDefaults.initialDraftFor!({
      artifactId: "a@1",
      status: "candidate",
      request: "Show sales as a calendar heatmap",
      uses: 1,
      sessions: 1,
      updatedAt: "",
    });
    expect(d.componentType).toBe("sales.calendarHeatmap");
    expect(d.intentName).toBe("sales.calendar_heatmap");
    expect(d.queryPath).toBe("trend");
    expect(salesPromotionDefaults.queryPaths).toEqual(["", "trend", "summary", "records", "kpi", "targets"]);
  });
});

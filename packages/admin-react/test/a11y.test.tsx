import { screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import {
  AnalyticsTab,
  FixationsTab,
  LineageTab,
  defaultAdminMessages as m,
  PromotionsTab,
} from "../src/index.js";
import { SUMMARY } from "./analytics-tab.test.js";
import { AXE_OPTIONS } from "./axe-config.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

const candidate = {
  artifactId: "sales.customViz1@1",
  status: "candidate",
  request: "Show me a custom revenue widget",
  html: "<div>hi</div>",
  uses: 3,
  sessions: 2,
  updatedAt: "2026-01-01T00:00:00Z",
};
const handlers = {
  "GET /lineage": () =>
    jsonResponse({
      events: [
        {
          id: "1",
          ts: "2026-01-01T09:00:00Z",
          type: "view.composed",
          actor: { kind: "model" },
          payload: {
            tier: "L1",
            cache: "miss",
            canonical: "sales.trend",
            intentHash: "sha256:abcdef",
            surface: "web",
          },
        },
      ],
    }),
  "GET /analytics/summary": () => jsonResponse(SUMMARY),
  "POST /promotions/evaluate": () => jsonResponse({ candidates: [candidate] }),
  "GET /fixations/proposals": () =>
    jsonResponse({
      proposals: [{ intentHash: "sha256:aa", canonical: "sales.trend", params: {}, uses: 5, stability: 0.9 }],
    }),
  "GET /fixations": () =>
    jsonResponse({
      fixations: [
        { intentHash: "sha256:bb", canonical: "sales.summary", fixatedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }),
};

describe("a11y (axe structural rules) per tab", () => {
  it("LineageTab", async () => {
    const { container } = renderInAdmin(<LineageTab />, { handlers });
    await screen.findByText("view.composed");
    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
  });

  it("AnalyticsTab", async () => {
    const { container } = renderInAdmin(<AnalyticsTab />, { handlers });
    await screen.findByText("sales.trend");
    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
  });

  it("PromotionsTab", async () => {
    const { container } = renderInAdmin(<PromotionsTab />, { handlers });
    await screen.findByText(candidate.artifactId);
    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
  });

  it("FixationsTab", async () => {
    const { container } = renderInAdmin(<FixationsTab />, { handlers });
    await screen.findByText(m.fixations.fixatedTitle);
    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
  });

  // Carried note: re-check the promotion-lifecycle pill's contrast (V.subtle on V.track) under axe, in both
  // light and dark theme. axe's own `color-contrast` rule is disabled above (jsdom cannot sample paint, same
  // as renderer-wc's parity harness) — it cannot itself agree or disagree with a contrast ratio here in either
  // theme, so this only re-confirms the rest of the structural ruleset still passes once the dark-mode values
  // are the ones actually resolving through the `var(--kohaku-color-subtle, …)` / `var(--kohaku-color-track, …)`
  // references (set on an ancestor, exactly how KohakuAdmin's `adminThemeStyle` would apply them). The contrast
  // ratio itself (~6.92:1 light / ~6.65:1 dark, both computed from the sample's real app-theme.css values —
  // see the task report) was verified separately with the WCAG relative-luminance formula, not through axe.
  it("AnalyticsTab promotion-lifecycle pill stays structurally clean with dark-theme color vars applied", async () => {
    document.body.style.setProperty("--kohaku-color-subtle", "#aab2c0");
    document.body.style.setProperty("--kohaku-color-track", "#262b35");
    try {
      const { container } = renderInAdmin(<AnalyticsTab />, { handlers });
      await screen.findByText("sales.trend");
      const pill = screen.getByText("generated").closest("span") as HTMLElement;
      expect(getComputedStyle(pill).color).toBe("var(--kohaku-color-subtle, #475569)");
      expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
    } finally {
      document.body.style.removeProperty("--kohaku-color-subtle");
      document.body.style.removeProperty("--kohaku-color-track");
    }
  });
});

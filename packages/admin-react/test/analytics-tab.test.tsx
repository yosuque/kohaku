import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalyticsTab, defaultAdminMessages } from "../src/index.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

export const SUMMARY = {
  window: { limit: 200, truncated: false },
  summary: {
    events: 12,
    composed: 5,
    tiers: { L0: 1, L1: 3, L2: 1 },
    cache: { hit: 2, miss: 3, bypass: 0, fixated: 0, other: 0 },
    fallback: { total: 1, byKind: { generation: 1, negotiation: 0, unspecified: 0 }, rate: 0.2 },
    durationMs: { count: 5, p50: 120, p95: 400, p99: 450, max: 500 },
    topIntents: [{ intentHash: "sha256:abcdef0123456789", canonical: "sales.trend", count: 4 }],
    promotions: { generated: 1, used: 3, nominated: 1, judged: 1, reviewed: 0, published: 0, withdrawn: 0 },
    fixations: { fixated: 1, unfixated: 0 },
  },
  promotionPolicy: { fixationMinUses: 3, promotionMinUses: 2 },
};

describe("AnalyticsTab", () => {
  it("renders the stat cards, tier bars and top intents from the summary", async () => {
    renderInAdmin(<AnalyticsTab />, { handlers: { "GET /analytics/summary": () => jsonResponse(SUMMARY) } });
    await screen.findByText(defaultAdminMessages.analytics.description(200, false, 12));
    expect(screen.getByText("20.0%")).toBeTruthy();
    expect(screen.getByText("400 ms")).toBeTruthy();
    expect(screen.getByText("sales.trend")).toBeTruthy();
    // The short hash is `intentHash.replace("sha256:", "#").slice(0, 10)` (10 chars, matching the original
    // sample's AnalyticsTab.tsx exactly): "sha256:abcdef0123456789" -> "#abcdef012".
    expect(screen.getByText("#abcdef012")).toBeTruthy();
  });

  it("notifies the denied message on 403 and stays on the loading card", async () => {
    const view = renderInAdmin(<AnalyticsTab />, {
      handlers: {
        "GET /analytics/summary": () =>
          jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
      },
    });
    await screen.findByText(defaultAdminMessages.analytics.loading);
    await new Promise((r) => setTimeout(r, 0));
    expect(view.notices[0]).toEqual({
      text: defaultAdminMessages.deniedMessage("CAPABILITY_DENIED", defaultAdminMessages.analytics.opRead),
      kind: "error",
    });
  });
});

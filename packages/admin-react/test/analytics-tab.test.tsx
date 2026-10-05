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
    promotions: {
      generated: 1,
      used: 3,
      nominated: 1,
      schemaSuggested: 1,
      judged: 1,
      reviewed: 0,
      schemaEdited: 1,
      published: 0,
      withdrawn: 0,
    },
    fixations: { fixated: 1, unfixated: 0 },
    review: { count: 1, durationMs: { p50: 90_000, p95: 90_000, max: 90_000 }, acceptedAsIs: 1 },
    usage: [
      {
        day: "2026-07-01",
        tenant: "",
        composed: 5,
        cache: { hit: 2, miss: 3, bypass: 0, fixated: 0 },
        tiers: { L0: 1, L1: 3, L2: 1 },
        l2Generated: 1,
        fallbacks: 1,
        tokens: { input: 1234, output: 567 },
        fixated: 1,
        unfixated: 0,
      },
    ],
  },
  promotionPolicy: { fixationMinUses: 3, promotionMinUses: 2 },
};

// Distinct, non-overlapping counts/percentages per section so each assertion below can only be satisfied by
// that section actually rendering (fix round 1, Finding 2: the brief's own test never independently exercised
// the tier-distribution bars, the cache breakdown, the fallback breakdown or the promotion-lifecycle section).
const FULL_SUMMARY = {
  window: { limit: 150, truncated: true },
  summary: {
    events: 30,
    composed: 8,
    tiers: { L0: 1, L1: 2, L2: 7 }, // 10%, 20%, 70%
    cache: { hit: 5, miss: 3, bypass: 2, fixated: 0, other: 10 }, // 25%, 15%, 10%, 0%, 50%
    fallback: { total: 5, byKind: { generation: 4, negotiation: 1, unspecified: 0 }, rate: 0.42 }, // 80%, 20%, 0%
    durationMs: { count: 10, p50: 100, p95: 333, p99: 380, max: 400 },
    topIntents: [{ intentHash: "sha256:1111111111111111", canonical: "reporting.dash", count: 9 }],
    promotions: {
      generated: 7,
      used: 2,
      nominated: 5,
      schemaSuggested: 6,
      judged: 1,
      reviewed: 9,
      schemaEdited: 2,
      published: 0,
      withdrawn: 3,
    },
    fixations: { fixated: 4, unfixated: 6 },
    review: { count: 8, durationMs: { p50: 45_000, p95: 200_000, max: 300_000 }, acceptedAsIs: 3 },
    usage: [
      {
        day: "2026-07-01",
        tenant: "acme",
        composed: 6,
        cache: { hit: 4, miss: 2, bypass: 0, fixated: 0 },
        tiers: { L0: 0, L1: 3, L2: 3 },
        l2Generated: 2,
        fallbacks: 0,
        tokens: { input: 7001, output: 802 },
        fixated: 0,
        unfixated: 0,
      },
      {
        day: "2026-07-02",
        tenant: "globex",
        composed: 2,
        cache: { hit: 1, miss: 1, bypass: 0, fixated: 0 },
        tiers: { L0: 1, L1: 1, L2: 0 },
        l2Generated: 0,
        fallbacks: 1,
        tokens: { input: 9, output: 3 },
        fixated: 1,
        unfixated: 0,
      },
    ],
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

  it("renders the tier-distribution bars, cache breakdown, fallback breakdown and promotion lifecycle", async () => {
    const view = renderInAdmin(<AnalyticsTab />, {
      handlers: { "GET /analytics/summary": () => jsonResponse(FULL_SUMMARY) },
    });
    await screen.findByText(defaultAdminMessages.analytics.description(150, true, 30));

    expect(screen.getByText(defaultAdminMessages.analytics.tierDistribution)).toBeTruthy();
    expect(screen.getByText(defaultAdminMessages.analytics.cacheBreakdown)).toBeTruthy();
    expect(screen.getByText(defaultAdminMessages.analytics.fallbackBreakdown)).toBeTruthy();
    expect(screen.getByText(defaultAdminMessages.analytics.promotionLifecycle)).toBeTruthy();

    const text = view.container.textContent ?? "";
    // Tier distribution (L0/L1/L2 = 1/2/7 of 10).
    expect(text).toContain("1(10%)");
    expect(text).toContain("2(20%)");
    expect(text).toContain("7(70%)");
    // Cache breakdown (hit/miss/bypass/other = 5/3/2/10 of 20).
    expect(text).toContain("5(25%)");
    expect(text).toContain("3(15%)");
    expect(text).toContain("10(50%)");
    // Fallback breakdown (generation/negotiation = 4/1 of 5).
    expect(text).toContain("4(80%)");
    expect(text).toContain("1(20%)");
    // Promotion lifecycle pills ("<label> <strong>{n}</strong>").
    expect(text).toContain("generated 7");
    expect(text).toContain("reviewed 9");
  });

  it("renders the Usage by day table with the sample caveat, and (none) for an unrecorded tenant", async () => {
    const view = renderInAdmin(<AnalyticsTab />, {
      handlers: { "GET /analytics/summary": () => jsonResponse(SUMMARY) },
    });
    await screen.findByText(defaultAdminMessages.analytics.usageByDay);
    expect(screen.getByText(defaultAdminMessages.analytics.usageNote(200))).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text).toContain("2026-07-01");
    expect(text).toContain(defaultAdminMessages.analytics.usageNoTenant);
    expect(text).toContain("1234");
    expect(text).toContain("567");
    for (const header of [
      defaultAdminMessages.analytics.usageDay,
      defaultAdminMessages.analytics.usageTenant,
      defaultAdminMessages.analytics.usageComposed,
      defaultAdminMessages.analytics.usageHit,
      defaultAdminMessages.analytics.usageMiss,
      defaultAdminMessages.analytics.usageL2Generated,
      defaultAdminMessages.analytics.usageTokensIn,
      defaultAdminMessages.analytics.usageTokensOut,
      defaultAdminMessages.analytics.usageFixated,
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeTruthy();
    }
  });

  it("renders one Usage by day row per (day, tenant) and the empty state when usage is empty or absent", async () => {
    const full = renderInAdmin(<AnalyticsTab />, {
      handlers: { "GET /analytics/summary": () => jsonResponse(FULL_SUMMARY) },
    });
    await screen.findByText(defaultAdminMessages.analytics.usageByDay);
    const text = full.container.textContent ?? "";
    expect(text).toContain("acme");
    expect(text).toContain("globex");
    expect(text).toContain("7001");
    full.unmount();

    const { usage: _usage, ...summaryWithoutUsage } = SUMMARY.summary;
    renderInAdmin(<AnalyticsTab />, {
      handlers: {
        "GET /analytics/summary": () => jsonResponse({ ...SUMMARY, summary: summaryWithoutUsage }),
      },
    });
    await screen.findByText(defaultAdminMessages.analytics.noUsage);
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

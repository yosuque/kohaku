import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalyticsTab, defaultAdminMessages } from "../src/index.js";
import { PENDING_PROMOTION_STATUSES } from "../src/pending-statuses.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

/** The `?status=` of a GET /promotions request. */
function statusOf(url: string): string | null {
  return new URL(url, "http://x").searchParams.get("status");
}

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
    l2ByIntent: [{ canonical: "sales.customViz", intentHash: "sha256:c0ffee", generated: 4, fallbacks: 1 }],
    schemaEditsByComponent: [
      {
        key: "sales.calendarHeatmap",
        count: 3,
        topFields: [
          { field: "description", count: 3 },
          { field: "intentName", count: 1 },
        ],
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
    l2ByIntent: [
      { canonical: "reporting.funnel", intentHash: "sha256:aaaa", generated: 11, fallbacks: 2 },
      { canonical: "reporting.sankey", intentHash: "sha256:bbbb", generated: 6, fallbacks: 0 },
    ],
    schemaEditsByComponent: [
      { key: "reporting.funnelChart", count: 5, topFields: [{ field: "paramsJsonSchema", count: 4 }] },
      { key: "art-orphan", count: 1, topFields: [{ field: "version", count: 1 }] },
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
      defaultAdminMessages.analytics.usageCacheFixated,
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

  it("renders the Catalog gaps section: L2 intents, most-edited schemas, and the pending promotion count", async () => {
    const statuses = [
      "in_use",
      "candidate",
      "judging",
      "judge_failed",
      "in_review",
      "changes_requested",
      "approved",
      "schema_proposed",
      "published",
      "rejected",
      "withdrawn",
      "candidate",
    ];
    const view = renderInAdmin(<AnalyticsTab />, {
      handlers: {
        "GET /analytics/summary": () => jsonResponse(FULL_SUMMARY),
        // The route narrows by one status at a time (`?status=`), like the real host.
        "GET /promotions": (call) => {
          const wanted = statusOf(call.url);
          return jsonResponse({
            candidates: statuses
              .map((status, i) => ({
                artifactId: `art-${i}`,
                status,
                uses: 1,
                sessions: 1,
                updatedAt: "2026-07-01T00:00:00.000Z",
              }))
              .filter((c) => wanted == null || c.status === wanted),
          });
        },
      },
    });
    await screen.findByText(defaultAdminMessages.analytics.catalogGaps);
    const a = defaultAdminMessages.analytics;
    expect(screen.getByText(a.l2Intents)).toBeTruthy();
    expect(screen.getByText(a.editedSchemas)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: a.gapIntent })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: a.gapComponent })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: a.gapFallbacks })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: a.gapEdits })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: a.gapTopFields })).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text).toContain("reporting.funnel");
    expect(text).toContain("reporting.sankey");
    expect(text).toContain("reporting.funnelChart");
    expect(text).toContain("art-orphan");
    expect(text).toContain("paramsJsonSchema (4)");
    // 8 pending: candidate x2, judging, judge_failed, in_review, changes_requested, approved, schema_proposed.
    const pendingCard = screen.getByText(a.pendingPromotions).parentElement;
    await waitFor(() => expect(pendingCard?.textContent).toContain(`${a.pendingPromotions}8`));
    // The count is only final once every response is in ("ready"), not merely once some text appeared.
    await waitFor(() => expect(pendingCard?.getAttribute("data-state")).toBe("ready"));
    // One status-narrowed GET /promotions per pending status (7), in parallel; never a full list scan, and the
    // terminal / in_use statuses are not asked for.
    const listed = view.calls
      .filter((c) => c.url.split("?")[0]!.endsWith("/promotions"))
      .map((c) => statusOf(c.url));
    expect(listed.sort()).toEqual([...PENDING_PROMOTION_STATUSES].sort());
  });

  it("shows the Catalog gaps empty states and an em dash when the promotions list is unavailable", async () => {
    const { l2ByIntent: _l2, schemaEditsByComponent: _edits, ...summaryWithoutGaps } = SUMMARY.summary;
    const view = renderInAdmin(<AnalyticsTab />, {
      handlers: {
        "GET /analytics/summary": () => jsonResponse({ ...SUMMARY, summary: summaryWithoutGaps }),
        "GET /promotions": () => jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
      },
    });
    await screen.findByText(defaultAdminMessages.analytics.noL2Intents);
    expect(screen.getByText(defaultAdminMessages.analytics.noSchemaEdits)).toBeTruthy();
    // The pending card falls back to "—" and, unlike the Promotions tab, does not raise a notice. "—" alone is
    // also what a still-loading card shows, so wait until all 7 status reads were issued and the card says it
    // is unavailable (not loading) before asserting on it.
    const pendingCard = screen.getByText(defaultAdminMessages.analytics.pendingPromotions).parentElement;
    await waitFor(() => expect(pendingCard?.getAttribute("data-state")).toBe("unavailable"));
    const listed = view.calls
      .filter((c) => c.url.split("?")[0]!.endsWith("/promotions"))
      .map((c) => statusOf(c.url));
    expect(listed.sort()).toEqual([...PENDING_PROMOTION_STATUSES].sort());
    expect(view.notices).toEqual([]);
    expect(pendingCard?.textContent).toContain("—");
  });

  it("stays silent on a 401 for the pending count too (a role without promotion.list)", async () => {
    const view = renderInAdmin(<AnalyticsTab />, {
      handlers: {
        "GET /analytics/summary": () => jsonResponse(SUMMARY),
        "GET /promotions": () => jsonResponse({ error: { code: "UNAUTHENTICATED", message: "no" } }, 401),
      },
    });
    await screen.findByText(defaultAdminMessages.analytics.catalogGaps);
    await new Promise((r) => setTimeout(r, 20));
    expect(view.notices).toEqual([]);
  });

  it("tells a non-auth failure of the pending count once, not once per status, and shows an em dash", async () => {
    const view = renderInAdmin(<AnalyticsTab />, {
      handlers: {
        "GET /analytics/summary": () => jsonResponse(SUMMARY),
        "GET /promotions": (call) =>
          statusOf(call.url) === "judging" || statusOf(call.url) === "approved"
            ? jsonResponse({ error: { code: "INTERNAL", message: "boom" } }, 500)
            : jsonResponse({ candidates: [] }),
      },
    });
    await screen.findByText(defaultAdminMessages.analytics.catalogGaps);
    await waitFor(() =>
      expect(view.notices).toEqual([
        { text: defaultAdminMessages.analytics.pendingFetchFailed, kind: "error" },
      ]),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(view.notices).toHaveLength(1);
    expect(
      screen.getByText(defaultAdminMessages.analytics.pendingPromotions).parentElement?.textContent,
    ).toContain("—");
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

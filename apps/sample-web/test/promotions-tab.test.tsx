import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t as dict } from "../src/i18n/ui.js";
import { PromotionsTab } from "../src/pages/admin/PromotionsTab.js";

/**
 * Characterization tests for PromotionsTab pinned BEFORE the SDK / decomposition refactor (proposals 6 and 18).
 * They exercise the component exactly as a user would (render + click), asserting on the exact displayed
 * strings (from ui.ts) and on the request shape sent for approve. Any refactor that changes wire requests or
 * displayed text must fail these tests.
 */

interface Notice {
  text: string;
  kind?: "info" | "error";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A request without "heatmap" in it, so PromotionCard's default draft stays the non-heatmap defaults
// (componentType sales.customViz1 / intentName sales.custom_viz_1 — see PromotionsTab.tsx's isHeatmap check).
function candidate(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    artifactId: "sales.customViz1@1",
    status: "candidate",
    request: "Show me a custom revenue widget",
    uses: 3,
    sessions: 2,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

type FetchCall = { url: string; init?: RequestInit };

/**
 * Installs a fetch stub and returns the recorded calls plus a handler table keyed by "METHOD path-suffix".
 * PromotionsTab's reload() also fires a background GET /analytics/summary on every render (it sources the
 * empty-state "N or more uses" threshold from there) that is orthogonal to what each test scenario below is
 * about, so it gets a default response here unless a test explicitly overrides "GET /analytics/summary".
 */
function stubFetch(handlers: Record<string, (call: FetchCall) => Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  const defaults: Record<string, (call: FetchCall) => Response> = {
    "GET /analytics/summary": () =>
      jsonResponse({ promotionPolicy: { fixationMinUses: 3, promotionMinUses: 2 } }),
  };
  const table = { ...defaults, ...handlers };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      const method = init?.method ?? "GET";
      const key = Object.keys(table).find(
        (k) => k.startsWith(`${method} `) && url.endsWith(k.slice(method.length + 1)),
      );
      if (key == null) throw new Error(`unhandled fetch: ${method} ${url}`);
      return table[key]!(call);
    }),
  );
  return calls;
}

describe("PromotionsTab (characterization, pre-refactor)", () => {
  let notices: Notice[];
  const onNotice = (text: string, kind?: "info" | "error") => notices.push({ text, kind });

  beforeEach(() => {
    notices = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the exact denied message on 403 CAPABILITY_DENIED for approve", async () => {
    const cand = candidate();
    stubFetch({
      "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
      "POST /promotions/sales.customViz1%401/approve": () =>
        jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "viewer cannot approve" } }, 403),
    });

    render(<PromotionsTab onNotice={onNotice} />);
    await screen.findByText(cand.artifactId as string);

    fireEvent.click(screen.getByText(dict().admin.promotions.approveButton));

    await waitFor(() => expect(notices.length).toBeGreaterThan(0));
    const expected = dict().admin.deniedMessage("CAPABILITY_DENIED", dict().admin.promotions.opApprove);
    expect(notices[0]).toEqual({ text: expected, kind: "error" });
  });

  it("shows the exact failed-notice text on 422 PROMOTION_INVALID for approve", async () => {
    const cand = candidate();
    stubFetch({
      "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
      "POST /promotions/sales.customViz1%401/approve": () =>
        jsonResponse({ error: { code: "PROMOTION_INVALID", message: "component already published" } }, 422),
    });

    render(<PromotionsTab onNotice={onNotice} />);
    await screen.findByText(cand.artifactId as string);

    fireEvent.click(screen.getByText(dict().admin.promotions.approveButton));

    await waitFor(() => expect(notices.length).toBeGreaterThan(0));
    const expected = dict().admin.promotions.failedNotice("component already published");
    expect(notices[0]).toEqual({ text: expected, kind: "error" });
  });

  it("shows the exact success notice and sends the draft payload for approve (200)", async () => {
    const cand = candidate();
    let approveCall: FetchCall | null = null;
    stubFetch({
      "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
      "POST /promotions/sales.customViz1%401/approve": (call) => {
        approveCall = call;
        return jsonResponse({ candidate: { ...cand, status: "published" } });
      },
    });

    render(<PromotionsTab onNotice={onNotice} />);
    await screen.findByText(cand.artifactId as string);

    fireEvent.click(screen.getByText(dict().admin.promotions.approveButton));

    await waitFor(() => expect(notices.length).toBeGreaterThan(0));
    const expected = dict().admin.promotions.promotedNotice(
      "sales.customViz1",
      "1.0.0",
      "sales.custom_viz_1",
    );
    expect(notices[0]).toEqual({ text: expected, kind: undefined });

    // Request shape: path/method + the draft payload built from PromotionCard's default form state.
    expect(approveCall).not.toBeNull();
    expect(approveCall!.url).toBe("/api/kohaku/promotions/sales.customViz1%401/approve");
    expect(approveCall!.init?.method).toBe("POST");
    const body = JSON.parse(approveCall!.init!.body as string) as { draft: Record<string, unknown> };
    expect(body.draft).toEqual({
      componentType: "sales.customViz1",
      version: "1.0.0",
      intentName: "sales.custom_viz_1",
      description: "Show me a custom revenue widget",
      paramsJsonSchema: {
        type: "object",
        properties: {
          fiscalYear: { type: "integer", default: 2026 },
          region: { type: "string", enum: ["japan", "north_america", "europe", "apac"] },
        },
      },
      queryTemplate: {
        path: "trend",
        fixedParams: { metric: "revenue", granularity: "month" },
        paramMap: { fiscalYear: "fy", region: "region" },
      },
    });
  });
});

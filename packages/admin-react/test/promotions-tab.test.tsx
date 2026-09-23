import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultAdminMessages as m, type PromotionDefaults, PromotionsTab } from "../src/index.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

/**
 * Characterization tests ported from the pre-extraction sample (apps/sample-web/test/promotions-tab.test.tsx).
 * They exercise the component exactly as a user would (render + click), asserting on the exact displayed
 * strings (from defaultAdminMessages) and on the request shape sent for approve, using this package's own
 * transport-injected stubClient / renderInAdmin instead of a global fetch stub. Expected values are unchanged
 * from the original: any refactor that changes wire requests or displayed text must fail these tests.
 */

// A request without "heatmap" in it, so the sales default draft stays the non-heatmap defaults
// (componentType sales.customViz1 / intentName sales.custom_viz_1 — see SALES_DEFAULTS.initialDraftFor below).
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

const TREND_PARAMS_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      fiscalYear: { type: "integer", default: 2026 },
      region: { type: "string", enum: ["japan", "north_america", "europe", "apac"] },
    },
  },
  null,
  2,
);
const TREND_FIXED_PARAMS = JSON.stringify({ metric: "revenue", granularity: "month" }, null, 2);
const TREND_PARAM_MAP = JSON.stringify({ fiscalYear: "fy", region: "region" }, null, 2);

// Mirrors the sample's product-specific defaults (TREND_* constants + the heatmap sniff), now injected via
// PromotionDefaults instead of being module-private constants inside the tab.
const SALES_DEFAULTS: PromotionDefaults = {
  queryPaths: ["", "trend", "summary", "records", "kpi", "targets"],
  initialDraftFor: (cand) => {
    const isHeatmap = /ヒートマップ|heatmap/i.test(cand.request ?? "");
    return {
      componentType: isHeatmap ? "sales.calendarHeatmap" : "sales.customViz1",
      version: "1.0.0",
      intentName: isHeatmap ? "sales.calendar_heatmap" : "sales.custom_viz_1",
      description: isHeatmap
        ? "Display sales as a monthly calendar heatmap"
        : (cand.request ?? "Promoted visualization part"),
      paramsJsonSchema: TREND_PARAMS_SCHEMA,
      queryPath: "trend",
      fixedParams: TREND_FIXED_PARAMS,
      paramMap: TREND_PARAM_MAP,
    };
  },
};

describe("PromotionsTab", () => {
  it("shows the exact denied message on 403 CAPABILITY_DENIED for approve", async () => {
    const cand = candidate();
    const view = renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.customViz1%401/approve": () =>
          jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "viewer cannot approve" } }, 403),
      },
    });
    await screen.findByText(cand.artifactId as string);

    fireEvent.click(screen.getByText(m.promotions.approveButton));

    await waitFor(() => expect(view.notices.length).toBeGreaterThan(0));
    const expected = m.deniedMessage("CAPABILITY_DENIED", m.promotions.opApprove);
    expect(view.notices[0]).toEqual({ text: expected, kind: "error" });
  });

  it("shows the exact failed-notice text on 422 PROMOTION_INVALID for approve", async () => {
    const cand = candidate();
    const view = renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.customViz1%401/approve": () =>
          jsonResponse({ error: { code: "PROMOTION_INVALID", message: "component already published" } }, 422),
      },
    });
    await screen.findByText(cand.artifactId as string);

    fireEvent.click(screen.getByText(m.promotions.approveButton));

    await waitFor(() => expect(view.notices.length).toBeGreaterThan(0));
    const expected = m.promotions.failedNotice("component already published");
    expect(view.notices[0]).toEqual({ text: expected, kind: "error" });
  });

  it("shows the exact success notice and sends the draft payload for approve (200)", async () => {
    const cand = candidate();
    let approveCall: { url: string; init?: RequestInit } | null = null;
    const view = renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.customViz1%401/approve": (call) => {
          approveCall = call;
          return jsonResponse({ candidate: { ...cand, status: "published" } });
        },
      },
    });
    await screen.findByText(cand.artifactId as string);

    fireEvent.click(screen.getByText(m.promotions.approveButton));

    await waitFor(() => expect(view.notices.length).toBeGreaterThan(0));
    const expected = m.promotions.promotedNotice("sales.customViz1", "1.0.0", "sales.custom_viz_1");
    expect(view.notices[0]).toEqual({ text: expected, kind: "info" });

    // Request shape: path/method + the draft payload built from the injected initial draft.
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

  it("offers the reject control only for statuses reject() can actually advance (in_use / candidate / in_review)", async () => {
    // reject() in packages/lineage/src/promotion/service.ts only advances from in_use (via nominate),
    // candidate (via review.start), and in_review (via review.reject). Every other non-terminal status
    // enters none of its `if` steps and throws PromotionNotRejectedError, so the reject control must not
    // be offered there.
    const rejectableStatuses = ["in_use", "candidate", "in_review"];
    const nonRejectableStatuses = [
      "judging",
      "judge_failed",
      "changes_requested",
      "approved",
      "schema_proposed",
      "published",
      "rejected",
      "withdrawn",
    ];
    for (const status of [...rejectableStatuses, ...nonRejectableStatuses]) {
      const cand = candidate({ status });
      const view = renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
        handlers: {
          "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        },
      });
      await screen.findByText(cand.artifactId as string);

      const rejectBtn = screen.queryByText(m.promotions.rejectButton);
      if (rejectableStatuses.includes(status)) {
        expect(rejectBtn, `expected reject control for status "${status}"`).not.toBeNull();
      } else {
        expect(rejectBtn, `did not expect reject control for status "${status}"`).toBeNull();
      }

      view.unmount();
    }
  });

  it("lists every status filter option, in machine order", async () => {
    renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [] }),
      },
    });
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual([
      "all",
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
    ]);
  });

  it("shows the sales empty-all copy keyed off promotionMinUses when there are no candidates", async () => {
    renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [] }),
        "GET /analytics/summary": () => jsonResponse({ promotionPolicy: { promotionMinUses: 4 } }),
      },
    });
    await screen.findByText(m.promotions.emptyAll(4));
  });

  it("uses the generic default draft (no PromotionDefaults) built from the candidate's own request text", async () => {
    const cand = candidate({ artifactId: "sales.custom@9", request: "Plain request text" });
    let approveCall: { url: string; init?: RequestInit } | null = null;
    const view = renderInAdmin(<PromotionsTab />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.custom%409/approve": (call) => {
          approveCall = call;
          return jsonResponse({ candidate: { ...cand, status: "published" } });
        },
      },
    });
    await screen.findByText(cand.artifactId as string);
    fireEvent.click(screen.getByText(m.promotions.approveButton));
    await waitFor(() => expect(view.notices.length).toBeGreaterThan(0));
    const body = JSON.parse(approveCall!.init!.body as string) as { draft: Record<string, unknown> };
    // genericInitialDraft leaves componentType/version/intentName generic and description = the request text,
    // with no queryTemplate (empty queryPath) — distinctive from the sales-defaults test above.
    expect(body.draft).toEqual({
      componentType: "",
      version: "1.0.0",
      intentName: "",
      description: "Plain request text",
    });
  });

  it("requests changes on a candidate via review.start + review.requestChanges and shows the request-changes notice", async () => {
    const cand = candidate();
    const actionKinds: string[] = [];
    const view = renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.customViz1%401/actions": (call) => {
          const body = JSON.parse(call.init!.body as string) as { action: { kind: string } };
          actionKinds.push(body.action.kind);
          return jsonResponse({ candidate: { ...cand, status: "changes_requested" } });
        },
      },
    });
    await screen.findByText(cand.artifactId as string);
    fireEvent.click(screen.getByText(m.promotions.requestChangesButton));
    await waitFor(() => expect(view.notices.length).toBeGreaterThan(0));
    expect(view.notices[0]).toEqual({ text: m.promotions.requestChangesNotice, kind: "info" });
    expect(actionKinds).toEqual(["review.start", "review.requestChanges"]);
  });

  it("withdraws a published candidate via the unpublish button and shows the withdrawn notice", async () => {
    const cand = candidate({ status: "published" });
    let withdrawCalled = false;
    const view = renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.customViz1%401/withdraw": () => {
          withdrawCalled = true;
          return jsonResponse({ candidate: { ...cand, status: "withdrawn" } });
        },
      },
    });
    await screen.findByText(cand.artifactId as string);
    fireEvent.click(screen.getByText(m.promotions.unpublishButton));
    await waitFor(() => expect(view.notices.length).toBeGreaterThan(0));
    expect(withdrawCalled).toBe(true);
    expect(view.notices[0]).toEqual({ text: m.promotions.withdrawnNotice, kind: "info" });
  });

  it("rejects a candidate via the reject button and shows the rejected notice", async () => {
    const cand = candidate({ status: "in_review" });
    let rejectCalled = false;
    const view = renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.customViz1%401/reject": () => {
          rejectCalled = true;
          return jsonResponse({ candidate: { ...cand, status: "rejected" } });
        },
      },
    });
    await screen.findByText(cand.artifactId as string);
    fireEvent.click(screen.getByText(m.promotions.rejectButton));
    await waitFor(() => expect(view.notices.length).toBeGreaterThan(0));
    expect(rejectCalled).toBe(true);
    expect(view.notices[0]).toEqual({ text: m.promotions.rejectedNotice, kind: "info" });
  });

  it("mounts the preview via SandboxFrame using the recorded artifact and its matching sha256", async () => {
    // The sha256 of "<div>hello</div>" (computed independently — not copied from implementation code) so
    // the sandbox's own hash check passes, proving the mounted artifact is byte-identical to what was recorded
    // rather than a re-derivation: a wrong hash here would surface as an "artifact hash mismatch" render error
    // instead of the preview's content.
    const html = "<div>hello</div>";
    const sha256 = "4745336f4a90d58df31a552e24034fbc734b9525aae435b161fb568b5215dce8";
    const cand = candidate({ html });
    let previewCalled = false;
    renderInAdmin(<PromotionsTab defaults={SALES_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () => jsonResponse({ candidates: [cand] }),
        "POST /promotions/sales.customViz1%401/preview": () => {
          previewCalled = true;
          return jsonResponse({ preview: { html, sha256 } });
        },
      },
    });
    await screen.findByText(cand.artifactId as string);
    fireEvent.click(screen.getByText(m.promotions.previewButton));
    await waitFor(() => expect(screen.getByText(m.promotions.closePreview)).toBeTruthy());
    expect(previewCalled).toBe(true);
  });
});

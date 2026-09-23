import { fireEvent, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { defaultAdminMessages, type PromotionDefaults, PromotionsTab } from "../src/index.js";
import { AXE_OPTIONS } from "./axe-config.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

const SUGGESTION = {
  draft: {
    componentType: "sales.calendarHeatmap",
    version: "1.0.0",
    intentName: "sales.calendar_heatmap",
    description: "Display sales as a monthly calendar heatmap",
    paramsJsonSchema: { type: "object", properties: { fiscalYear: { type: "integer", default: 2026 } } },
    queryTemplate: {
      path: "trend",
      fixedParams: { metric: "revenue", granularity: "month" },
      paramMap: { fiscalYear: "fy" },
    },
  },
  events: [{ name: "cellSelected", description: "A month cell was clicked" }],
  confidence: 0.9,
  model: "fake-model",
  extractorId: "l2-schema-extraction",
  extractorVersion: "0.1",
  suggestedAt: "2026-07-01T00:00:00.000Z",
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "art-1",
    status: "candidate",
    request: "Show me a custom revenue widget",
    uses: 3,
    sessions: 2,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A product prefill that must lose to the suggestion (and win when preferSuggestion is false). */
const PRODUCT_DEFAULTS: PromotionDefaults = {
  queryPaths: ["", "trend", "summary"],
  initialDraftFor: () => ({
    componentType: "sales.customViz1",
    version: "1.0.0",
    intentName: "sales.custom_viz_1",
    description: "Promoted visualization part",
    paramsJsonSchema: "",
    queryPath: "",
    fixedParams: "",
    paramMap: "",
  }),
};

const m = defaultAdminMessages.promotions;

describe("PromotionsTab with a schema suggestion", () => {
  it("prefills the form from the suggestion (over the product defaults) and shows the badge + events", async () => {
    const { container } = renderInAdmin(<PromotionsTab defaults={PRODUCT_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () =>
          jsonResponse({ candidates: [candidate({ suggestion: SUGGESTION })] }),
      },
    });
    await screen.findByText(m.suggestionBadge("fake-model", 90));
    expect((screen.getByLabelText("componentType") as HTMLInputElement).value).toBe("sales.calendarHeatmap");
    expect((screen.getByLabelText("intentName") as HTMLInputElement).value).toBe("sales.calendar_heatmap");
    expect(screen.getByText(m.suggestionEvents("cellSelected"))).toBeTruthy();
    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
  });

  it("keeps Approve disabled until the reviewer acknowledges, then sends the suggested draft verbatim", async () => {
    const { container, ...view } = renderInAdmin(<PromotionsTab defaults={PRODUCT_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () =>
          jsonResponse({ candidates: [candidate({ suggestion: SUGGESTION })] }),
        "POST /promotions/art-1/approve": () =>
          jsonResponse({ candidate: candidate({ status: "published" }) }),
      },
    });
    const approve = (await screen.findByText(m.approveButton)) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(m.suggestionAcknowledgeRequired)).toBeTruthy();
    // The richest a11y surface of this whole change: the checkbox, the disabled button, and the role="status"
    // message, all present at once — checked before the checkbox is ticked (unlike the first test's pass).
    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
    fireEvent.click(screen.getByLabelText(m.suggestionAcknowledge));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(view.calls.some((c) => c.url.endsWith("/promotions/art-1/approve"))).toBe(true),
    );
    const approveCall = view.calls.find((c) => c.url.endsWith("/approve"))!;
    expect(JSON.parse(String(approveCall.init!.body)) as { draft: unknown }).toEqual({
      draft: SUGGESTION.draft,
    });
    expect(view.notices.at(-1)?.text).toBe(
      m.promotedNotice("sales.calendarHeatmap", "1.0.0", "sales.calendar_heatmap"),
    );
  });

  it("marks an edited field in the diff with the suggested value", async () => {
    renderInAdmin(<PromotionsTab defaults={PRODUCT_DEFAULTS} />, {
      handlers: {
        "POST /promotions/evaluate": () =>
          jsonResponse({ candidates: [candidate({ suggestion: SUGGESTION })] }),
      },
    });
    const description = (await screen.findByLabelText(m.descriptionFieldLabel)) as HTMLInputElement;
    fireEvent.change(description, { target: { value: "Monthly sales heatmap" } });
    expect(screen.getByTestId("suggestion-diff-description").textContent).toContain(
      m.suggestionChangedFrom("Display sales as a monthly calendar heatmap"),
    );
    expect(screen.getByTestId("suggestion-diff-componentType").textContent).toContain(m.suggestionUnchanged);
  });

  it("preferSuggestion: false keeps the product prefill but still shows the panel and requires acknowledgement", async () => {
    renderInAdmin(<PromotionsTab defaults={{ ...PRODUCT_DEFAULTS, preferSuggestion: false }} />, {
      handlers: {
        "POST /promotions/evaluate": () =>
          jsonResponse({ candidates: [candidate({ suggestion: SUGGESTION })] }),
      },
    });
    const approve = (await screen.findByText(m.approveButton)) as HTMLButtonElement;
    expect((screen.getByLabelText("componentType") as HTMLInputElement).value).toBe("sales.customViz1");
    expect(screen.getByText(m.suggestionTitle)).toBeTruthy();
    expect(approve.disabled).toBe(true);
    // The diff shows the product prefill as an edit against the suggestion
    expect(screen.getByTestId("suggestion-diff-componentType").textContent).toContain(
      m.suggestionChangedFrom("sales.calendarHeatmap"),
    );
  });

  it("without a suggestion the product prefill applies, no panel is shown and Approve is enabled at once", async () => {
    renderInAdmin(<PromotionsTab defaults={PRODUCT_DEFAULTS} />, {
      handlers: { "POST /promotions/evaluate": () => jsonResponse({ candidates: [candidate()] }) },
    });
    const approve = (await screen.findByText(m.approveButton)) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect((screen.getByLabelText("componentType") as HTMLInputElement).value).toBe("sales.customViz1");
    expect(screen.queryByText(m.suggestionTitle)).toBeNull();
  });
});

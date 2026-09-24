import { screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { AnalyticsTab, defaultAdminMessages } from "../src/index.js";
import { SUMMARY } from "./analytics-tab.test.js";
import { AXE_OPTIONS } from "./axe-config.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

const a = defaultAdminMessages.analytics;

describe("AnalyticsTab review turnaround", () => {
  it("renders review p50 / p95 and the accepted-as-is count", async () => {
    const { container } = renderInAdmin(<AnalyticsTab />, {
      handlers: { "GET /analytics/summary": () => jsonResponse(SUMMARY) },
    });
    await screen.findByText(a.reviewTurnaround);
    expect(screen.getByText("1.5 min")).toBeTruthy();
    expect(screen.getByText(a.reviewTurnaroundSub("1.5 min", 1))).toBeTruthy();
    expect(screen.getByText(a.acceptedAsIs)).toBeTruthy();
    expect(screen.getByText(a.acceptedAsIsSub(1))).toBeTruthy();
    expect((await axe.run(container, AXE_OPTIONS)).violations).toEqual([]);
  });

  it("shows a dash when no review was measured", async () => {
    const empty = {
      ...SUMMARY,
      summary: {
        ...SUMMARY.summary,
        review: { count: 0, durationMs: { p50: null, p95: null, max: null }, acceptedAsIs: 0 },
      },
    };
    renderInAdmin(<AnalyticsTab />, { handlers: { "GET /analytics/summary": () => jsonResponse(empty) } });
    await screen.findByText(a.reviewTurnaround);
    expect(screen.getByText(a.reviewTurnaroundSub("—", 0))).toBeTruthy();
  });
});

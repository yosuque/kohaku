import { describe, expect, it } from "vitest";
import { DEFAULT_MESSAGES } from "../src/index.js";

describe("DEFAULT_MESSAGES", () => {
  it("formatting functions return the same wording as renderer-react", () => {
    expect(DEFAULT_MESSAGES.spreadsheetTotal("1,234", 20)).toBe("Showing 20 of 1,234 rows");
    expect(DEFAULT_MESSAGES.chartDefaultLabel("bar")).toBe("bar chart");
    expect(DEFAULT_MESSAGES.nodeRenderFailed("presentChart", "c1")).toBe(
      "Failed to render component (presentChart / c1)",
    );
  });

  it("metricDelta's suffix changes by direction", () => {
    expect(DEFAULT_MESSAGES.metricDelta("+3", "up")).toBe("+3 (up)");
    expect(DEFAULT_MESSAGES.metricDelta("-3", "down")).toBe("-3 (down)");
    expect(DEFAULT_MESSAGES.metricDelta("0", "flat")).toBe("0");
  });

  it("metricAriaLabel branches on presence of delta", () => {
    expect(DEFAULT_MESSAGES.metricAriaLabel("Sales", "¥100", "+3")).toBe("Sales: ¥100, change +3");
    expect(DEFAULT_MESSAGES.metricAriaLabel("Sales", "¥100", null)).toBe("Sales: ¥100");
  });

  it("spreadsheetEditCell composes the aria-label of an editable cell's edit-trigger button", () => {
    expect(DEFAULT_MESSAGES.spreadsheetEditCell("Revenue")).toBe("Edit Revenue");
  });
});

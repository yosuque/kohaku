import { describe, expect, it } from "vitest";
import { salesCalendarHeatmap, salesKpiCard } from "../src/index.js";

describe("sample-parts", () => {
  it("salesKpiCard is a valid, frozen ComponentDefinition", () => {
    expect(salesKpiCard.type).toBe("sales.kpiCard");
    expect(salesKpiCard.version).toBe("1.0.0");
    expect(Object.isFrozen(salesKpiCard)).toBe(true);
  });

  it("salesCalendarHeatmap is a valid, frozen ComponentDefinition", () => {
    expect(salesCalendarHeatmap.type).toBe("sales.calendarHeatmap");
    expect(salesCalendarHeatmap.version).toBe("1.0.0");
    expect(Object.isFrozen(salesCalendarHeatmap)).toBe(true);
  });
});

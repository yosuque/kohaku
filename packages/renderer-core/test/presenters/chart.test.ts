import type { JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  A11Y_TABLE_ROW_CAP,
  CHART_TOKEN_KEYS,
  describeChartDataTable,
  prepareRows,
} from "../../src/index.js";

describe("prepareRows", () => {
  it("without series, rows pass through as-is and yKeys come from the y prop", () => {
    const rows: JsonObject[] = [{ month: "1", revenue: 10 }];
    expect(prepareRows(rows, "month", "revenue", undefined)).toEqual({ rows, yKeys: ["revenue"] });
  });

  it("uses y as yKeys when it is an array; defaults to 'value' when unspecified", () => {
    const rows: JsonObject[] = [];
    expect(prepareRows(rows, "month", ["a", "b"], undefined).yKeys).toEqual(["a", "b"]);
    expect(prepareRows(rows, "month", undefined, undefined).yKeys).toEqual(["value"]);
  });

  it("pivots the series column long → wide and natural-sorts yKeys", () => {
    const rows: JsonObject[] = [
      { month: "1", region: "japan", value: 10 },
      { month: "1", region: "us", value: 20 },
      { month: "2", region: "japan", value: 5 },
    ];
    const out = prepareRows(rows, "month", "value", "region");
    expect(out.rows).toEqual([
      { month: "1", japan: 10, us: 20 },
      { month: "2", japan: 5 },
    ]);
    expect(out.yKeys).toEqual(["japan", "us"]);
  });

  it("numeric-labeled series sort numerically, not lexicographically (10 after 2)", () => {
    const rows: JsonObject[] = [
      { x: "a", s: "10", value: 1 },
      { x: "a", s: "2", value: 2 },
    ];
    expect(prepareRows(rows, "x", "value", "s").yKeys).toEqual(["2", "10"]);
  });
});

describe("describeChartDataTable", () => {
  it("headers are [x, ...yKeys], in that order", () => {
    const rows: JsonObject[] = [{ month: "1", revenue: 10, cost: 4 }];
    const out = describeChartDataTable("month", ["revenue", "cost"], rows);
    expect(out.headers).toEqual(["month", "revenue", "cost"]);
  });

  it("cells stringify each row in header order", () => {
    const rows: JsonObject[] = [
      { month: "1", revenue: 10, cost: 4 },
      { month: "2", revenue: 20, cost: 8 },
    ];
    const out = describeChartDataTable("month", ["revenue", "cost"], rows);
    expect(out.cells).toEqual([
      ["1", "10", "4"],
      ["2", "20", "8"],
    ]);
  });

  it("null/undefined cell values become the empty string", () => {
    const rows: JsonObject[] = [{ month: "1", revenue: null }, { month: "2" }];
    const out = describeChartDataTable("month", ["revenue"], rows);
    expect(out.cells).toEqual([
      ["1", ""],
      ["2", ""],
    ]);
  });

  it("rows beyond A11Y_TABLE_ROW_CAP are dropped", () => {
    const rows: JsonObject[] = Array.from({ length: A11Y_TABLE_ROW_CAP + 1 }, (_, i) => ({
      month: String(i),
      revenue: i,
    }));
    const out = describeChartDataTable("month", ["revenue"], rows);
    expect(out.cells).toHaveLength(A11Y_TABLE_ROW_CAP);
    expect(out.cells[out.cells.length - 1]).toEqual([
      String(A11Y_TABLE_ROW_CAP - 1),
      String(A11Y_TABLE_ROW_CAP - 1),
    ]);
  });
});

describe("CHART_TOKEN_KEYS", () => {
  it("matches the theme token keys both renderers resolve", () => {
    expect(CHART_TOKEN_KEYS).toEqual({
      palette: "chart.palette",
      axis: "chart.axis",
      dotStroke: "color.background",
      axisLabel: "color.muted",
    });
  });
});

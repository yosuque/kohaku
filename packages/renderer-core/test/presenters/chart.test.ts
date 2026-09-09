import type { JsonObject } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { prepareRows } from "../../src/index.js";

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

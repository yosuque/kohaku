import type { JsonObject, TabularColumn } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { compareRows, describeSortHeader, formatCell, rowKey, sortRows } from "../../src/index.js";

const numCol: TabularColumn = { key: "revenue", type: "number" };
const strCol: TabularColumn = { key: "region", type: "string" };
const labeledCol: TabularColumn = { key: "region", type: "string", label: "Region" };

describe("formatCell", () => {
  it("number-column numbers are thousands-separated, null is empty, object is JSON, others are String", () => {
    expect(formatCell(1234, numCol, "en-US")).toBe("1,234");
    expect(formatCell(null, numCol, "en-US")).toBe("");
    expect(formatCell({ a: 1 }, strCol, "en-US")).toBe('{"a":1}');
    expect(formatCell("japan", strCol, "en-US")).toBe("japan");
  });
});

describe("compareRows / sortRows", () => {
  const rows: JsonObject[] = [
    { region: "b", revenue: 2 },
    { region: "a", revenue: 10 },
    { region: "c", revenue: 1 },
  ];

  it("numeric columns compare by numeric difference, strings by localeCompare; reversed by dir", () => {
    expect(
      compareRows({ revenue: 1 }, { revenue: 2 }, { field: "revenue", dir: "asc" }, "en-US"),
    ).toBeLessThan(0);
    expect(
      compareRows({ revenue: 1 }, { revenue: 2 }, { field: "revenue", dir: "desc" }, "en-US"),
    ).toBeGreaterThan(0);
  });

  it("sortRows returns a new array and does not mutate the original", () => {
    const asc = sortRows(rows, { field: "revenue", dir: "asc" }, "en-US");
    expect(asc.map((r) => r["revenue"])).toEqual([1, 2, 10]);
    // the original array is unchanged
    expect(rows.map((r) => r["revenue"])).toEqual([2, 10, 1]);
  });

  it("unspecified sort returns an order-preserving copy", () => {
    const copy = sortRows(rows, undefined, "en-US");
    expect(copy).not.toBe(rows);
    expect(copy).toEqual(rows);
  });
});

describe("rowKey", () => {
  it("serialized column values + index; distinguishes even same-name collisions by index", () => {
    const cols: TabularColumn[] = [strCol, numCol];
    const r: JsonObject = { region: "japan", revenue: 5 };
    expect(rowKey(r, cols, 0)).toBe('["japan",5]#0');
    expect(rowKey(r, cols, 1)).toBe('["japan",5]#1');
  });

  it("serializes the whole row when columns are empty", () => {
    expect(rowKey({ a: 1 }, [], 2)).toBe('{"a":1}#2');
  });
});

describe("describeSortHeader", () => {
  it("falls back to col.key when col.label is absent; numeric reflects col.type", () => {
    const h = describeSortHeader(strCol, undefined);
    expect(h.label).toBe("region");
    expect(h.numeric).toBe(false);
    const hNum = describeSortHeader(numCol, undefined);
    expect(hNum.numeric).toBe(true);
  });

  it("prefers col.label when present", () => {
    expect(describeSortHeader(labeledCol, undefined).label).toBe("Region");
  });

  it("an unsorted or differently-sorted column is inactive with no aria-sort / arrow", () => {
    const h = describeSortHeader(strCol, undefined);
    expect(h.active).toBe(false);
    expect(h.ariaSort).toBeUndefined();
    expect(h.arrow).toBeUndefined();

    const other = describeSortHeader(strCol, { field: "revenue", dir: "asc" });
    expect(other.active).toBe(false);
    expect(other.ariaSort).toBeUndefined();
    expect(other.arrow).toBeUndefined();
  });

  it("ascending sort on this column: active, aria-sort=ascending, arrow=▲", () => {
    const h = describeSortHeader(strCol, { field: "region", dir: "asc" });
    expect(h.active).toBe(true);
    expect(h.ariaSort).toBe("ascending");
    expect(h.arrow).toBe("▲");
  });

  it("descending sort on this column: active, aria-sort=descending, arrow=▼", () => {
    const h = describeSortHeader(strCol, { field: "region", dir: "desc" });
    expect(h.active).toBe(true);
    expect(h.ariaSort).toBe("descending");
    expect(h.arrow).toBe("▼");
  });
});

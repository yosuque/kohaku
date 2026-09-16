import type { JsonObject, TabularColumn } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  applyLocalView,
  compareRows,
  describeSortHeader,
  formatCell,
  localFooterTotal,
  rowKey,
  SPREADSHEET_HARD_ROW_CAP,
  sortRows,
} from "../../src/index.js";

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

describe("applyLocalView", () => {
  it("returns the identical rows reference when there is no sort and no truncation", () => {
    const rows: JsonObject[] = [{ region: "a" }, { region: "b" }];
    expect(applyLocalView(rows, undefined, undefined, "en-US")).toBe(rows);
    expect(applyLocalView(rows, undefined, 10, "en-US")).toBe(rows);
  });

  it("truncates to pageSize when rows exceed it (a new array, original untouched)", () => {
    const rows: JsonObject[] = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const view = applyLocalView(rows, undefined, 2, "en-US");
    expect(view).not.toBe(rows);
    expect(view.map((r) => r["n"])).toEqual([1, 2]);
    expect(rows).toHaveLength(3);
  });

  it("caps at SPREADSHEET_HARD_ROW_CAP even with no pageSize declared (501 -> 500)", () => {
    const rows: JsonObject[] = Array.from({ length: SPREADSHEET_HARD_ROW_CAP + 1 }, (_, i) => ({ n: i }));
    const view = applyLocalView(rows, undefined, undefined, "en-US");
    expect(view).toHaveLength(SPREADSHEET_HARD_ROW_CAP);
    expect(view).not.toBe(rows);
  });

  it("a declared pageSize can never exceed the hard cap", () => {
    const rows: JsonObject[] = Array.from({ length: SPREADSHEET_HARD_ROW_CAP + 10 }, (_, i) => ({ n: i }));
    const view = applyLocalView(rows, undefined, SPREADSHEET_HARD_ROW_CAP + 5, "en-US");
    expect(view).toHaveLength(SPREADSHEET_HARD_ROW_CAP);
  });

  it("when sorted, returns a sorted+sliced copy and does not mutate the original", () => {
    const rows: JsonObject[] = [{ n: 3 }, { n: 1 }, { n: 2 }];
    const view = applyLocalView(rows, { field: "n", dir: "asc" }, 2, "en-US");
    expect(view.map((r) => r["n"])).toEqual([1, 2]);
    expect(rows.map((r) => r["n"])).toEqual([3, 1, 2]);
  });
});

describe("localFooterTotal", () => {
  it("uses data.total when reported and it exceeds shown", () => {
    expect(localFooterTotal({ total: 10, rows: [{}, {}] }, 2)).toBe(10);
  });

  it("falls back to the full local row count when total is unreported", () => {
    const rows = Array.from({ length: 5 }, () => ({}));
    expect(localFooterTotal({ rows }, 2)).toBe(5);
  });

  it("returns undefined when nothing was truncated", () => {
    expect(localFooterTotal({ total: 2, rows: [{}, {}] }, 2)).toBeUndefined();
    expect(localFooterTotal({ rows: [{}, {}] }, 2)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { McpResultError, McpToolError, toTabularData } from "../src/tabular.js";

const ROWS = [
  { id: "o-1", total: 10.5, paid: true, placedAt: "2026-04-01" },
  { id: "o-2", total: 3, paid: false, placedAt: "2026-04-02T10:00:00Z" },
];

const EXPECTED = {
  columns: [
    { key: "id", type: "string" },
    { key: "total", type: "number" },
    { key: "paid", type: "boolean" },
    { key: "placedAt", type: "date" },
  ],
  rows: ROWS,
  dataVersion: "v1",
};

describe("toTabularData", () => {
  it("reads an array in structuredContent", () => {
    expect(toTabularData({ content: [], structuredContent: ROWS }, "v1")).toEqual(EXPECTED);
  });

  it("reads a JSON array in the first text content when there is no structuredContent", () => {
    const result = { content: [{ type: "text", text: JSON.stringify(ROWS) }] };
    expect(toTabularData(result, "v1")).toEqual(EXPECTED);
  });

  it("accepts an object whose rows property is the array", () => {
    expect(toTabularData({ content: [], structuredContent: { rows: ROWS, note: "x" } }, "v1")).toEqual(
      EXPECTED,
    );
  });

  it("accepts an object with a single array property (a wrapped list result)", () => {
    expect(toTabularData({ content: [], structuredContent: { result: ROWS } }, "v1")).toEqual(EXPECTED);
  });

  it("prefers structuredContent over the text content", () => {
    const result = { content: [{ type: "text", text: "[]" }], structuredContent: ROWS };
    expect(toTabularData(result, "v1").rows).toEqual(ROWS);
  });

  it("infers the columns from the first 50 rows only, in first-appearance order", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ a: i }));
    rows.push({ a: 50, late: "x" } as never);
    const data = toTabularData({ content: [], structuredContent: rows }, "v1");
    expect(data.columns).toEqual([{ key: "a", type: "number" }]);
    expect(data.rows).toHaveLength(51);
  });

  it("types a column string when its values are mixed, and ignores nulls", () => {
    const data = toTabularData(
      {
        content: [],
        structuredContent: [
          { a: 1, b: null, c: { x: 1 } },
          { a: "x", b: 2, c: [1] },
        ],
      },
      "v1",
    );
    expect(data.columns).toEqual([
      { key: "a", type: "string" },
      { key: "b", type: "number" },
      { key: "c", type: "string" },
    ]);
  });

  it("returns no columns for an empty list", () => {
    expect(toTabularData({ content: [], structuredContent: [] }, "v1")).toEqual({
      columns: [],
      rows: [],
      dataVersion: "v1",
    });
  });

  it.each([
    ["a scalar", { content: [], structuredContent: 3 }],
    ["an object with several non-row properties", { content: [], structuredContent: { a: 1, b: 2 } }],
    ["an array of non-objects", { content: [], structuredContent: [1, 2] }],
    ["free text", { content: [{ type: "text", text: "no rows today" }] }],
    ["JSON text that is not JSON (NaN)", { content: [{ type: "text", text: "[NaN]" }] }],
    ["an empty result", { content: [] }],
    ["a non-text first content", { content: [{ type: "image", data: "x" }] }],
  ])("throws McpResultError for %s", (_label, result) => {
    expect(() => toTabularData(result, "v1")).toThrow(McpResultError);
  });

  it("refuses a result with more rows than maxRows, and one larger than maxResultBytes", () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const result = { content: [], structuredContent: rows };
    expect(() => toTabularData(result, "v1", "t", { maxRows: 2 })).toThrow(/more than 2 rows/);
    expect(toTabularData(result, "v1", "t", { maxRows: 3 }).rows).toHaveLength(3);
    const size = new TextEncoder().encode(JSON.stringify(rows)).length;
    expect(() => toTabularData(result, "v1", "t", { maxResultBytes: size - 1 })).toThrow(/larger than/);
    expect(toTabularData(result, "v1", "t", { maxResultBytes: size }).rows).toHaveLength(3);
  });

  it("measures the size in UTF-8 bytes, not characters", () => {
    const result = { content: [], structuredContent: [{ a: "日本語" }] };
    const bytes = new TextEncoder().encode(JSON.stringify([{ a: "日本語" }])).length;
    expect(() => toTabularData(result, "v1", "t", { maxResultBytes: bytes - 1 })).toThrow(McpResultError);
    expect(toTabularData(result, "v1", "t", { maxResultBytes: bytes }).rows).toHaveLength(1);
  });

  it("throws McpToolError, without a wire code, when the tool reports isError", () => {
    try {
      toTabularData({ isError: true, content: [{ type: "text", text: "boom" }] }, "v1");
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      expect((error as McpToolError).message).toContain("boom");
      expect("code" in (error as object)).toBe(false);
    }
  });
});

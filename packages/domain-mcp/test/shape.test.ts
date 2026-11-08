import { describe, expect, it } from "vitest";
import { shapeFromOutputSchema } from "../src/shape.js";

const ROW = {
  type: "object",
  properties: {
    id: { type: "string" },
    total: { type: "number" },
    qty: { type: "integer" },
    paid: { type: "boolean" },
    placedAt: { type: "string", format: "date-time" },
    day: { type: "string", format: "date" },
    meta: { type: "object" },
  },
};

const EXPECTED = {
  columns: [
    { name: "id", type: "string", role: "dimension" },
    { name: "total", type: "number", role: "measure" },
    { name: "qty", type: "number", role: "measure" },
    { name: "paid", type: "boolean" },
    { name: "placedAt", type: "date", role: "time" },
    { name: "day", type: "date", role: "time" },
  ],
};

describe("shapeFromOutputSchema", () => {
  it("maps a wrapped rows array", () => {
    const schema = { type: "object", properties: { rows: { type: "array", items: ROW } } };
    expect(shapeFromOutputSchema(schema)).toEqual(EXPECTED);
  });

  it("maps a root array and a single wrapped array property", () => {
    expect(shapeFromOutputSchema({ type: "array", items: ROW })).toEqual(EXPECTED);
    expect(
      shapeFromOutputSchema({ type: "object", properties: { result: { type: "array", items: ROW } } }),
    ).toEqual(EXPECTED);
  });

  it.each([
    ["no outputSchema", undefined],
    ["a scalar schema", { type: "string" }],
    ["an object with no array", { type: "object", properties: { total: { type: "number" } } }],
    ["an array of scalars", { type: "array", items: { type: "string" } }],
    ["items with no properties", { type: "array", items: { type: "object" } }],
  ])("returns null for %s", (_label, schema) => {
    expect(shapeFromOutputSchema(schema)).toBeNull();
  });
});

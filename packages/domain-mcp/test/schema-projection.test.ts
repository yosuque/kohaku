import { ActionParamsSchemaSchema } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { projectInputSchema } from "../src/schema-projection.js";

describe("projectInputSchema", () => {
  it("drops annotation keywords, closes the schema, and reports what was dropped", () => {
    const result = projectInputSchema({
      type: "object",
      properties: { q: { type: "string", description: "x", maxLength: 10 } },
      required: ["q"],
    });
    expect(result).toEqual({
      schema: {
        type: "object",
        properties: { q: { type: "string", maxLength: 10 } },
        required: ["q"],
        additionalProperties: false,
      },
      dropped: ["properties.q.description"],
      omitted: false,
      reasons: [],
    });
  });

  it("produces a schema that kohaku's closed ActionParamsSchema subset accepts", () => {
    const result = projectInputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      title: "refund",
      properties: {
        orderId: { type: "string", pattern: "^o-", minLength: 1, format: "uuid" },
        amount: { type: "number", minimum: 0, maximum: 1000, default: 5 },
        qty: { type: "integer", exclusiveMinimum: 0 },
        mode: { type: "string", enum: ["full", "partial"] },
        notify: { type: "boolean" },
        tags: { type: "array", items: { type: "string", maxLength: 8 }, maxItems: 4, minItems: 1 },
        nested: { type: "object", properties: { a: { type: "string" } } },
      },
      required: ["orderId", "amount"],
      additionalProperties: false,
    });
    expect(result.omitted).toBe(false);
    expect(ActionParamsSchemaSchema.safeParse(result.schema).success).toBe(true);
    expect(result.dropped).toEqual([
      "$schema",
      "title",
      "properties.orderId.pattern",
      "properties.orderId.format",
      "properties.amount.default",
      "properties.qty.exclusiveMinimum",
      "properties.tags.minItems",
    ]);
    // Nested objects are closed too, and an already-closed root stays closed.
    expect(result.schema).toMatchObject({
      additionalProperties: false,
      properties: { nested: { type: "object", additionalProperties: false } },
    });
  });

  it("closes a property-less object schema", () => {
    expect(projectInputSchema({ type: "object" }).schema).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it.each([
    ["anyOf", { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } } }],
    ["oneOf", { type: "object", oneOf: [{ properties: {} }] }],
    ["$ref", { type: "object", properties: { a: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string" } } }],
    ["a type array", { type: "object", properties: { a: { type: ["string", "null"] } } }],
    ["additionalProperties: true", { type: "object", additionalProperties: true }],
    ["an additionalProperties schema", { type: "object", additionalProperties: { type: "string" } }],
    ["a tuple items", { type: "object", properties: { a: { type: "array", items: [{ type: "string" }] } } }],
    ["a non-object root", { type: "string" }],
    ["a typeless node", { type: "object", properties: { a: {} } }],
    ["a malformed enum", { type: "object", properties: { a: { type: "string", enum: [{ x: 1 }] } } }],
    ["a fractional maxLength", { type: "object", properties: { a: { type: "string", maxLength: 1.5 } } }],
    ["an unknown keyword", { type: "object", properties: { a: { type: "string", someVendorThing: 1 } } }],
  ])("omits the schema for %s", (_label, input) => {
    const result = projectInputSchema(input);
    expect(result.omitted).toBe(true);
    expect(result.schema).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("names the offending path in reasons", () => {
    const result = projectInputSchema({
      type: "object",
      properties: { a: { anyOf: [{ type: "string" }] } },
    });
    expect(result.reasons).toEqual(["properties.a.anyOf"]);
  });

  it("omits when the input is not an object at all", () => {
    expect(projectInputSchema(null)).toMatchObject({ schema: null, omitted: true });
    expect(projectInputSchema(true)).toMatchObject({ schema: null, omitted: true });
  });
});

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { defineComponent, propsSchemaFromJsonSchema, toPropsJsonSchema } from "../src/index.js";

/** Thin helper that validates props against the result of running propsSchemaFromJsonSchema(schema). */
function parse(schema: unknown, props: unknown): { ok: boolean; data?: unknown } {
  const zodSchema = propsSchemaFromJsonSchema(schema);
  const result = zodSchema.safeParse(props);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

describe("propsSchemaFromJsonSchema (JSON Schema of a promoted draft → Zod)", () => {
  it("validates object + primitive (string / number / integer / boolean)", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "number" },
        page: { type: "integer" },
        active: { type: "boolean" },
      },
      required: ["title", "count", "page", "active"],
    };
    expect(parse(schema, { title: "x", count: 1.5, page: 2, active: true }).ok).toBe(true);
    // Reject a type mismatch (a float where an integer is expected).
    expect(parse(schema, { title: "x", count: 1, page: 2.5, active: true }).ok).toBe(false);
    // Reject a primitive type violation too.
    expect(parse(schema, { title: 1, count: 1, page: 2, active: true }).ok).toBe(false);
  });

  it("respects string enum as z.enum", () => {
    const schema = {
      type: "object",
      properties: { region: { type: "string", enum: ["japan", "apac"] } },
      required: ["region"],
    };
    expect(parse(schema, { region: "japan" }).ok).toBe(true);
    expect(parse(schema, { region: "europe" }).ok).toBe(false);
  });

  it("fills in default (a default value is set when omitted)", () => {
    const schema = {
      type: "object",
      properties: { fiscalYear: { type: "integer", default: 2026 } },
    };
    const result = parse(schema, {});
    expect(result.ok).toBe(true);
    expect((result.data as { fiscalYear: number }).fiscalYear).toBe(2026);
  });

  it("a non-required property is optional (allows omission)", () => {
    const schema = {
      type: "object",
      properties: { title: { type: "string" }, note: { type: "string" } },
      required: ["title"],
    };
    expect(parse(schema, { title: "x" }).ok).toBe(true);
    expect(parse(schema, {}).ok).toBe(false); // title is required
  });

  it("supports a one-level nested object and a primitive array", () => {
    const schema = {
      type: "object",
      properties: {
        meta: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["meta", "tags"],
    };
    expect(parse(schema, { meta: { label: "a" }, tags: ["x", "y"] }).ok).toBe(true);
    expect(parse(schema, { meta: { label: 1 }, tags: ["x"] }).ok).toBe(false);
  });

  it("unsupported structures (deep nesting / anyOf) fall to z.unknown().optional() (does not throw)", () => {
    const schema = {
      type: "object",
      properties: {
        // A two-level nested object is only supported one level → its contents are accepted loosely
        deep: { type: "object", properties: { inner: { type: "object", properties: {} } } },
        // anyOf is unsupported → unknown
        weird: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    };
    // Unsupported properties are optional, so both a missing value and any value pass.
    expect(parse(schema, {}).ok).toBe(true);
    expect(parse(schema, { deep: { inner: { anything: 1 } }, weird: [1, 2, 3] }).ok).toBe(true);
  });

  it("a non-object schema / missing falls back to loose z.record-based validation", () => {
    // A string schema (non-object).
    expect(parse({ type: "string" }, { anyKey: "anyValue" }).ok).toBe(true);
    // Missing (undefined).
    expect(parse(undefined, { a: 1, b: [2] }).ok).toBe(true);
    // record rejects a non-object value.
    expect(propsSchemaFromJsonSchema(undefined).safeParse("not an object").success).toBe(false);
  });

  it("the conversion result passes toPropsJsonSchema (unrepresentable:throw) without throwing", () => {
    const schemas: unknown[] = [
      {
        type: "object",
        properties: {
          title: { type: "string" },
          region: { type: "string", enum: ["japan", "apac"] },
          fiscalYear: { type: "integer", default: 2026 },
          tags: { type: "array", items: { type: "string" } },
          meta: { type: "object", properties: { label: { type: "string" } } },
          weird: { anyOf: [{ type: "string" }] },
        },
        required: ["title"],
      },
      { type: "string" }, // record fallback
      undefined, // record fallback
    ];
    for (const schema of schemas) {
      const def = defineComponent({
        type: "sales.promoted",
        version: "1.0.0",
        description: "promoted component(test)",
        // defineComponent itself checks JSON-representability under the same conditions as toPropsJsonSchema.
        propsSchema: propsSchemaFromJsonSchema(schema) as z.ZodObject,
        capabilities: { events: [], data: "required", children: "none" },
      });
      expect(() => toPropsJsonSchema(def)).not.toThrow();
    }
  });
});

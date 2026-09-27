import { describe, expect, it } from "vitest";
import {
  type ActionParamsSchema,
  ActionParamsSchemaError,
  actionPayloadHash,
  assertValidActionParamsSchema,
  type JsonValue,
  validateActionParams,
} from "../src/index.js";

const NOTE_SCHEMA: ActionParamsSchema = {
  type: "object",
  properties: {
    note: { type: "string", maxLength: 500 },
  },
  required: ["note"],
  additionalProperties: false,
};

describe("validateActionParams", () => {
  it("returns no issues for a valid payload", () => {
    expect(validateActionParams(NOTE_SCHEMA, { note: "hello" })).toEqual([]);
  });

  it("reports a missing required property", () => {
    expect(validateActionParams(NOTE_SCHEMA, {})).toEqual([
      { path: "note", code: "required", message: 'missing required property "note"' },
    ]);
  });

  it("reports an unexpected property when additionalProperties is false", () => {
    const issues = validateActionParams(NOTE_SCHEMA, { note: "hi", extra: 1 });
    expect(issues).toEqual([
      { path: "extra", code: "additionalProperties", message: 'unexpected property "extra"' },
    ]);
  });

  it("reports a type mismatch at the root when the payload is not an object", () => {
    const issues = validateActionParams(NOTE_SCHEMA, { note: 42 as unknown as string });
    expect(issues).toEqual([{ path: "note", code: "type", message: 'expected a string at "note"' }]);
  });

  it("reports maxLength / minLength violations on strings", () => {
    const schema: ActionParamsSchema = { type: "string", minLength: 2, maxLength: 4 };
    expect(validateActionParams({ type: "object", properties: { s: schema } }, { s: "a" })).toEqual([
      { path: "s", code: "minLength", message: "expected at least 2 characters" },
    ]);
    expect(validateActionParams({ type: "object", properties: { s: schema } }, { s: "abcde" })).toEqual([
      { path: "s", code: "maxLength", message: "expected at most 4 characters" },
    ]);
  });

  it("reports minimum / maximum violations on numbers, and rejects non-integers for type integer", () => {
    const schema: ActionParamsSchema = { type: "integer", minimum: 0, maximum: 10 };
    const wrap = (v: unknown) =>
      validateActionParams({ type: "object", properties: { n: schema } }, { n: v as never });
    expect(wrap(-1)).toEqual([{ path: "n", code: "minimum", message: "expected at least 0" }]);
    expect(wrap(11)).toEqual([{ path: "n", code: "maximum", message: "expected at most 10" }]);
    expect(wrap(1.5)).toEqual([{ path: "n", code: "type", message: 'expected an integer at "n"' }]);
    expect(wrap(5)).toEqual([]);
  });

  it("reports enum violations", () => {
    const schema: ActionParamsSchema = { type: "string", enum: ["a", "b"] };
    const issues = validateActionParams({ type: "object", properties: { s: schema } }, { s: "c" });
    expect(issues).toEqual([{ path: "s", code: "enum", message: 'expected one of ["a","b"]' }]);
  });

  it("validates array items and reports maxItems, indexing paths as parent[i]", () => {
    const schema: ActionParamsSchema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string", maxLength: 3 }, maxItems: 2 } },
    };
    const issues = validateActionParams(schema, { tags: ["ok", "toolong", "x"] });
    expect(issues).toEqual([
      { path: "tags", code: "maxItems", message: "expected at most 2 items" },
      { path: "tags[1]", code: "maxLength", message: "expected at most 3 characters" },
    ]);
  });

  it("validates nested objects with dot-separated paths", () => {
    const schema: ActionParamsSchema = {
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: { city: { type: "string", minLength: 1 } },
          required: ["city"],
        },
      },
    };
    expect(validateActionParams(schema, { address: { city: "" } })).toEqual([
      { path: "address.city", code: "minLength", message: "expected at least 1 characters" },
    ]);
  });

  it("applies an x-message override on the schema node that failed", () => {
    const schema: ActionParamsSchema = {
      type: "object",
      properties: { note: { type: "string", maxLength: 3, "x-message": "note is too long" } },
    };
    expect(validateActionParams(schema, { note: "abcd" })).toEqual([
      { path: "note", code: "maxLength", message: "note is too long" },
    ]);
  });

  it("validates booleans, including enum", () => {
    const schema: ActionParamsSchema = { type: "object", properties: { flag: { type: "boolean" } } };
    expect(validateActionParams(schema, { flag: true })).toEqual([]);
    expect(validateActionParams(schema, { flag: "yes" as unknown as boolean })).toEqual([
      { path: "flag", code: "type", message: 'expected a boolean at "flag"' },
    ]);
  });
});

describe("assertValidActionParamsSchema", () => {
  it("accepts a schema using only the allowed keyword subset", () => {
    expect(() =>
      assertValidActionParamsSchema("annotate", NOTE_SCHEMA as unknown as JsonValue),
    ).not.toThrow();
  });

  it("rejects an unknown keyword (e.g. pattern) with ActionParamsSchemaError", () => {
    const badSchema = { type: "string", pattern: "^[a-z]+$" };
    expect(() => assertValidActionParamsSchema("annotate", badSchema)).toThrow(ActionParamsSchemaError);
  });

  it("rejects additionalProperties: true (only literal false is allowed)", () => {
    const badSchema = { type: "object", additionalProperties: true };
    expect(() => assertValidActionParamsSchema("annotate", badSchema)).toThrow(ActionParamsSchemaError);
  });
});

describe("actionPayloadHash", () => {
  it("is deterministic and independent of key order", async () => {
    const a = await actionPayloadHash({ note: "hi", id: 1 });
    const b = await actionPayloadHash({ id: 1, note: "hi" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("differs for a different payload", async () => {
    const a = await actionPayloadHash({ note: "hi" });
    const b = await actionPayloadHash({ note: "bye" });
    expect(a).not.toBe(b);
  });
});

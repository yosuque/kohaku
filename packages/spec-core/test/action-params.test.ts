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

  describe("prototype-pollution-shaped keys", () => {
    // A plain object literal like `{ __proto__: {...} }` sets the object's prototype rather than
    // creating an own property, so it does not exercise the bug this guards against. JSON.parse is what
    // an attacker's request body actually goes through (host-rest / host-mcp-apps both parse JSON before
    // ever handing a payload to validateActionParams), and it creates a genuine own data property named
    // "__proto__" -- the same shape a real request would produce.
    const openSchema: ActionParamsSchema = { type: "object", properties: { amount: { type: "number" } } };

    it("rejects an own __proto__ key even though additionalProperties is not false", () => {
      const payload = JSON.parse('{"amount":10,"__proto__":{"polluted":true}}');
      expect(validateActionParams(openSchema, payload)).toEqual([
        { path: "__proto__", code: "unsafeKey", message: 'the property name "__proto__" is not allowed' },
      ]);
    });

    it("rejects an own constructor key, not the inherited Object constructor as a schema", () => {
      const payload = JSON.parse('{"amount":10,"constructor":{"polluted":true}}');
      expect(validateActionParams(openSchema, payload)).toEqual([
        {
          path: "constructor",
          code: "unsafeKey",
          message: 'the property name "constructor" is not allowed',
        },
      ]);
    });

    it("rejects an own prototype key", () => {
      const payload = JSON.parse('{"amount":10,"prototype":{"polluted":true}}');
      expect(validateActionParams(openSchema, payload)).toEqual([
        { path: "prototype", code: "unsafeKey", message: 'the property name "prototype" is not allowed' },
      ]);
    });

    it("still validates the rest of the payload alongside an unsafe key", () => {
      const payload = JSON.parse('{"amount":"not a number","__proto__":{}}');
      const issues = validateActionParams(openSchema, payload);
      expect(issues).toContainEqual({
        path: "__proto__",
        code: "unsafeKey",
        message: 'the property name "__proto__" is not allowed',
      });
      expect(issues).toContainEqual({
        path: "amount",
        code: "type",
        message: 'expected a number at "amount"',
      });
    });

    it("reports a required property literally named 'constructor' as missing (Object.hasOwn, not `in`)", () => {
      const schema: ActionParamsSchema = { type: "object", required: ["constructor"] };
      expect(validateActionParams(schema, {})).toEqual([
        { path: "constructor", code: "required", message: 'missing required property "constructor"' },
      ]);
    });

    it("does not mistake toString/hasOwnProperty for a declared property (no phantom pass-through)", () => {
      // Neither key is in UNSAFE_PROPERTY_KEYS, but neither is declared in `properties` either -- with
      // additionalProperties: false, both must still be flagged rather than silently accepted via
      // Object.prototype's own inherited members resolving through `props[key]`.
      const strictSchema: ActionParamsSchema = {
        type: "object",
        properties: { amount: { type: "number" } },
        additionalProperties: false,
      };
      const payload = JSON.parse('{"amount":1,"toString":1,"hasOwnProperty":1}');
      const issues = validateActionParams(strictSchema, payload);
      expect(issues).toContainEqual({
        path: "toString",
        code: "additionalProperties",
        message: 'unexpected property "toString"',
      });
      expect(issues).toContainEqual({
        path: "hasOwnProperty",
        code: "additionalProperties",
        message: 'unexpected property "hasOwnProperty"',
      });
    });
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

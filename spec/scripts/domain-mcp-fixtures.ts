/**
 * The cross-language cases for `@kohaku-ui/domain-mcp` / `kohaku.domain_mcp`, kept out of
 * generate-cross-language-fixtures.ts for size. Each section pins one pure function of the package, whose output
 * is deterministic and therefore must come out identical in the TS and the Python implementation:
 *
 * - `schemaProjection`: an MCP `inputSchema` -> the closed `paramsSchema` subset, the dropped keyword paths,
 *   the `omitted` flag and the reasons (`projectInputSchema`).
 * - `argumentCoercion`: the string parameters of a resolved ref -> typed MCP tool arguments, or an error
 *   (`coerceToolArguments`; `expected: null` means "throws ACTION_PARAMS_INVALID").
 * - `tabular`: a tool result -> `TabularData`, or an error (`toTabularData`; `expected: null` means "throws").
 * - `shape`: an `outputSchema` -> `DataShape` or null (`shapeFromOutputSchema`).
 *
 * Relative imports (not "@kohaku-ui/domain-mcp"), for the same reason as the composer / registry imports in the
 * generator: the spec package declares no dependency on it. Everything reached here imports only spec-core types.
 */
import { coerceToolArguments } from "../../packages/domain-mcp/src/coerce.js";
import { projectInputSchema } from "../../packages/domain-mcp/src/schema-projection.js";
import { shapeFromOutputSchema } from "../../packages/domain-mcp/src/shape.js";
import { type TabularLimits, toTabularData } from "../../packages/domain-mcp/src/tabular.js";
import type { McpCallResult } from "../../packages/domain-mcp/src/types.js";

const PROJECTION_INPUTS: unknown[] = [
  {
    type: "object",
    properties: { q: { type: "string", description: "x", maxLength: 10 } },
    required: ["q"],
  },
  {
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
  },
  { type: "object" },
  { type: "object", properties: { n: { type: "string", minimum: 1, items: { type: "string" } } } },
  { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } } },
  { type: "object", oneOf: [{ properties: {} }] },
  {
    type: "object",
    properties: { a: { $ref: "#/$defs/A" } },
    $defs: { A: { type: "string" } },
  },
  { type: "object", properties: { a: { type: ["string", "null"] } } },
  { type: "object", additionalProperties: true },
  { type: "object", additionalProperties: { type: "string" } },
  { type: "object", properties: { a: { type: "array", items: [{ type: "string" }] } } },
  { type: "string" },
  { type: "object", properties: { a: {} } },
  { type: "object", properties: { a: { type: "string", enum: [{ x: 1 }] } } },
  { type: "object", properties: { a: { type: "string", enum: ["x", 1, true, null] } } },
  { type: "object", properties: { a: { type: "string", maxLength: 1.5 } } },
  { type: "object", properties: { a: { type: "string", someVendorThing: 1, "x-note": "n" } } },
  { type: "object", required: "a" },
  { type: "object", properties: [] },
  {
    type: "object",
    properties: {
      orderId: { type: "string" },
      amount: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }], default: null, title: "Amount" },
      mode: { anyOf: [{ type: "null" }, { type: "string", enum: ["full", "partial"] }] },
    },
    required: ["orderId", "amount"],
  },
  {
    type: "object",
    properties: { a: { anyOf: [{ type: "integer" }, { type: "null" }] } },
    required: ["a"],
  },
  {
    type: "object",
    properties: { a: { anyOf: [{ type: "integer" }, { type: "string" }, { type: "null" }] } },
  },
  { type: "object", properties: { a: { anyOf: [{ type: "integer" }, { type: "null" }], oneOf: [] } } },
  { type: "object", properties: { a: { anyOf: [{ type: "null" }, { type: "null" }] } } },
  null,
  true,
];

const COERCION_SCHEMA = {
  type: "object",
  properties: {
    n: { type: "number" },
    b: { type: "boolean" },
    s: { type: "string" },
    limit: { type: "integer" },
  },
};

/**
 * Cases that need a raw JSON text, because a literal such as `1e999` (or a 400-digit integer) cannot survive being
 * built as a JS value and re-serialized: it is `Infinity` in JS, and `JSON.stringify` writes that as `null`.
 * Both languages parse `json` themselves, so a number beyond the double range is non-finite on both sides.
 */
const PROJECTION_RAW_JSON: string[] = [
  '{"type":"object","properties":{"a":{"type":"number","minimum":1e999}}}',
  `{"type":"object","properties":{"a":{"type":"number","maximum":1${"0".repeat(400)}}}}`,
  `{"type":"object","properties":{"a":{"type":"string","maxLength":1${"0".repeat(400)}}}}`,
  '{"type":"object","properties":{"a":{"type":"string","maxLength":1.0,"minLength":2}}}',
];

const COERCION_CASES: { args: Record<string, unknown>; inputSchema: unknown; maxLimit?: number }[] = [
  { args: { limit: "3", _limit: "5" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: 4, _limit: "5" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "5000" }, inputSchema: COERCION_SCHEMA },
  { args: { _limit: "2000" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "50", _limit: "40" }, inputSchema: COERCION_SCHEMA, maxLimit: 10 },
  { args: { limit: "5" }, inputSchema: COERCION_SCHEMA, maxLimit: 10 },
  { args: { n: "1".padEnd(401, "0") }, inputSchema: COERCION_SCHEMA },
  {
    args: { _limit: "5" },
    inputSchema: { type: "object", properties: { limit: { type: "string" } } },
  },
  { args: { n: "3", b: "true", s: "x", _limit: "5", _sort: "a" }, inputSchema: COERCION_SCHEMA },
  { args: { n: "-1.5", b: "false" }, inputSchema: COERCION_SCHEMA },
  { args: { n: "1e3", limit: "7" }, inputSchema: COERCION_SCHEMA },
  { args: { n: "3.0", limit: "3.0" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: "5" }, inputSchema: COERCION_SCHEMA },
  { args: { _cursor: "c", _limit: "2", _sort: "s", _dir: "asc", s: "x" }, inputSchema: { type: "object" } },
  {
    args: { _limit: "5", s: "x" },
    inputSchema: { type: "object", properties: { s: { type: "string" } } },
  },
  {
    args: { s: "1", other: "2", t: "true" },
    inputSchema: { type: "object", properties: { s: { type: "string" }, t: {} } },
  },
  { args: { n: 4, b: false }, inputSchema: COERCION_SCHEMA },
  {
    args: { limit: "5", flag: "true", either: "7" },
    inputSchema: {
      type: "object",
      properties: {
        limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
        flag: { anyOf: [{ type: "null" }, { type: "boolean" }] },
        either: { anyOf: [{ type: "integer" }, { type: "string" }] },
      },
    },
  },
  {
    args: { limit: "x" },
    inputSchema: {
      type: "object",
      properties: { limit: { anyOf: [{ type: "integer" }, { type: "null" }] } },
    },
  },
  { args: { n: "abc" }, inputSchema: COERCION_SCHEMA },
  { args: { n: "" }, inputSchema: COERCION_SCHEMA },
  { args: { n: " 3" }, inputSchema: COERCION_SCHEMA },
  { args: { n: "0x10" }, inputSchema: COERCION_SCHEMA },
  { args: { n: "01" }, inputSchema: COERCION_SCHEMA },
  { args: { n: "1e400" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "3.5" }, inputSchema: COERCION_SCHEMA },
  { args: { b: "yes" }, inputSchema: COERCION_SCHEMA },
  { args: { b: "True" }, inputSchema: COERCION_SCHEMA },
  { args: { _limit: "many" }, inputSchema: COERCION_SCHEMA },
  // `_limit` is outside the signed ref, so it may only lower the signed limit: a positive safe integer or nothing.
  { args: { limit: "1", _limit: "-1" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "1", _limit: "0" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "1", _limit: "0.5" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "1", _limit: "abc" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "1", _limit: "-1e9" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: "5" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: "5.0" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: "1e1" }, inputSchema: COERCION_SCHEMA },
  { args: { _limit: "1" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: 3 }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: -1 }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: 0.5 }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: true }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "9", _limit: "9007199254740993" }, inputSchema: COERCION_SCHEMA },
  // A signed limit that is not a positive integer would slip under maxLimit (the smaller wins): same rule.
  { args: { limit: "-1" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "0" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "-1", _limit: "5" }, inputSchema: COERCION_SCHEMA },
  { args: { limit: -1 }, inputSchema: COERCION_SCHEMA },
  { args: { limit: "0" }, inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { args: { limit: "0.5" }, inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  {
    args: { limit: "0", _limit: "-1" },
    inputSchema: { type: "object", properties: { limit: { type: "string" } } },
  },
  {
    args: { limit: "1", _limit: "0.5" },
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    args: { limit: "1", _limit: "-1" },
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
];

const ROWS = [
  { id: "o-1", total: 10.5, paid: true, placedAt: "2026-04-01" },
  { id: "o-2", total: 3, paid: false, placedAt: "2026-04-02T10:00:00Z" },
];

const TABULAR_CASES: McpCallResult[] = [
  { content: [], structuredContent: ROWS },
  { content: [{ type: "text", text: JSON.stringify(ROWS) }] },
  { content: [], structuredContent: { rows: ROWS, note: "x" } },
  { content: [], structuredContent: { result: ROWS } },
  { content: [{ type: "text", text: "[]" }], structuredContent: ROWS },
  {
    content: [],
    structuredContent: [
      { a: 1, b: null, c: { x: 1 } },
      { a: "x", b: 2, c: [1] },
    ],
  },
  { content: [], structuredContent: [{ d: "2026-01-01" }, { d: "not a date" }] },
  { content: [], structuredContent: [{ k: null }, { k: null }] },
  { content: [], structuredContent: [] },
  {
    content: [],
    structuredContent: Array.from({ length: 51 }, (_, i) => (i < 50 ? { a: i } : { a: i, late: "x" })),
  },
  { content: [], structuredContent: 3 },
  { content: [], structuredContent: { a: 1, b: 2 } },
  { content: [], structuredContent: [1, 2] },
  { content: [{ type: "text", text: "no rows today" }] },
  { content: [{ type: "text", text: "[NaN]" }] },
  { content: [] },
  { content: [{ type: "image", data: "x" }] },
  { isError: true, content: [{ type: "text", text: "boom" }] },
];

const THREE_ROWS = [{ a: 1 }, { a: 2 }, { a: 3 }];
// Byte sizes: `[{"a":1},{"a":2},{"a":3}]` is 25 bytes, and `[{"a":"日本語"}]` is 19 bytes in UTF-8 (but 13 characters).
const TABULAR_LIMIT_CASES: { result: McpCallResult; limits: TabularLimits }[] = [
  { result: { content: [], structuredContent: THREE_ROWS }, limits: { maxRows: 2 } },
  { result: { content: [], structuredContent: THREE_ROWS }, limits: { maxRows: 3 } },
  { result: { content: [], structuredContent: THREE_ROWS }, limits: { maxResultBytes: 24 } },
  { result: { content: [], structuredContent: THREE_ROWS }, limits: { maxResultBytes: 25 } },
  { result: { content: [], structuredContent: [{ a: "日本語" }] }, limits: { maxResultBytes: 18 } },
  { result: { content: [], structuredContent: [{ a: "日本語" }] }, limits: { maxResultBytes: 19 } },
];

const SHAPE_ROW = {
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

const SHAPE_INPUTS: unknown[] = [
  { type: "object", properties: { rows: { type: "array", items: SHAPE_ROW } } },
  { type: "array", items: SHAPE_ROW },
  { type: "object", properties: { result: { type: "array", items: SHAPE_ROW } } },
  { type: "string" },
  { type: "object", properties: { total: { type: "number" } } },
  { type: "array", items: { type: "string" } },
  { type: "array", items: { type: "object" } },
  { type: "array", items: { type: "object", properties: { meta: { type: "object" } } } },
];

/** `expected: null` stands for "the function threw". */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export function buildDomainMcpFixtures() {
  return {
    schemaProjection: PROJECTION_INPUTS.map((inputSchema) => ({
      inputSchema,
      expected: projectInputSchema(inputSchema),
    })),
    schemaProjectionRaw: PROJECTION_RAW_JSON.map((json) => ({
      json,
      expected: projectInputSchema(JSON.parse(json)),
    })),
    argumentCoercion: COERCION_CASES.map(({ args, inputSchema, maxLimit }) => ({
      args,
      inputSchema,
      ...(maxLimit !== undefined ? { maxLimit } : {}),
      expected: attempt(() =>
        coerceToolArguments(args as never, inputSchema as never, maxLimit !== undefined ? { maxLimit } : {}),
      ),
    })),
    tabular: [
      ...TABULAR_CASES.map((result) => ({ result, limits: undefined as TabularLimits | undefined })),
      ...TABULAR_LIMIT_CASES,
    ].map(({ result, limits }) => ({
      result,
      dataVersion: "mcp:1",
      ...(limits !== undefined ? { limits } : {}),
      expected: attempt(() => toTabularData(result, "mcp:1", undefined, limits ?? {})),
    })),
    shape: SHAPE_INPUTS.map((outputSchema) => ({
      outputSchema,
      expected: shapeFromOutputSchema(outputSchema),
    })),
  };
}

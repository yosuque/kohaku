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
import { toTabularData } from "../../packages/domain-mcp/src/tabular.js";
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

const COERCION_CASES: { args: Record<string, unknown>; inputSchema: unknown }[] = [
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
  { content: [] },
  { content: [{ type: "image", data: "x" }] },
  { isError: true, content: [{ type: "text", text: "boom" }] },
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
    argumentCoercion: COERCION_CASES.map(({ args, inputSchema }) => ({
      args,
      inputSchema,
      expected: attempt(() => coerceToolArguments(args as never, inputSchema as never)),
    })),
    tabular: TABULAR_CASES.map((result) => ({
      result,
      dataVersion: "mcp:1",
      expected: attempt(() => toTabularData(result, "mcp:1")),
    })),
    shape: SHAPE_INPUTS.map((outputSchema) => ({
      outputSchema,
      expected: shapeFromOutputSchema(outputSchema),
    })),
  };
}

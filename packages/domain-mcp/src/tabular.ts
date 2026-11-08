import type { ColumnType, JsonObject, TabularColumn, TabularData } from "@kohaku-ui/spec-core";
import { isPlainObject } from "./internal.js";
import type { McpCallResult } from "./types.js";

/** The tool ran but reported `isError: true`. No wire `code`: the upstream text must not reach a UI client verbatim. */
export class McpToolError extends Error {
  constructor(tool: string | undefined, detail: string) {
    super(`MCP tool${tool == null ? "" : ` "${tool}"`} reported an error: ${detail}`);
    this.name = "McpToolError";
  }
}

/** The tool succeeded but its result cannot be read as a list of rows. */
export class McpResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpResultError";
  }
}

/** How many leading rows the column types are inferred from. */
export const COLUMN_INFERENCE_ROWS = 50;

/** A date or date-time as ISO 8601 (extended notation). Identical in the Python mirror. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$/;

const MAX_ERROR_TEXT = 500;

/**
 * Picks the list out of a decoded tool result: the value itself when it is an array, otherwise the `rows`
 * property, otherwise the only property of an object (a wrapped list such as `{ "result": [...] }`, which is what
 * several MCP SDKs produce for a tool that returns a list). Returns null when no list can be found.
 */
export function findRowList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return null;
  const rows = payload["rows"];
  if (Array.isArray(rows)) return rows;
  const keys = Object.keys(payload);
  if (keys.length === 1) {
    const only = payload[keys[0] as string];
    if (Array.isArray(only)) return only;
  }
  return null;
}

function textOf(result: McpCallResult): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * The decoded payload of a successful tool result: `structuredContent` when present, otherwise the first content
 * block when it is JSON text. Returns `undefined` when there is neither.
 */
export function payloadOf(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const first = result.content?.[0];
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      return JSON.parse(first.text) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Throws `McpToolError` for an `isError` result. */
export function assertToolSucceeded(result: McpCallResult, tool?: string): void {
  if (result.isError === true) {
    const text = textOf(result);
    throw new McpToolError(tool, text === "" ? "(no detail)" : text.slice(0, MAX_ERROR_TEXT));
  }
}

function kindOf(value: unknown): "number" | "boolean" | "date" | "string" | "other" {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return DATE_PATTERN.test(value) ? "date" : "string";
  return "other";
}

/**
 * Infers the columns from the first {@link COLUMN_INFERENCE_ROWS} rows: keys in first-appearance order; a column
 * is `number` / `boolean` / `date` when every non-null value in the sample is of that kind, otherwise `string`.
 */
export function inferColumns(rows: JsonObject[]): TabularColumn[] {
  const kinds = new Map<string, Set<string>>();
  for (const row of rows.slice(0, COLUMN_INFERENCE_ROWS)) {
    for (const [key, value] of Object.entries(row)) {
      let seen = kinds.get(key);
      if (seen == null) {
        seen = new Set();
        kinds.set(key, seen);
      }
      if (value !== null) seen.add(kindOf(value));
    }
  }
  const columns: TabularColumn[] = [];
  for (const [key, seen] of kinds) {
    let type: ColumnType = "string";
    if (seen.size === 1) {
      const only = [...seen][0];
      if (only === "number" || only === "boolean" || only === "date") type = only;
    }
    columns.push({ key, type });
  }
  return columns;
}

/** Default cap on the number of rows of one query result. */
export const DEFAULT_MAX_ROWS = 10_000;

/** Default cap on the serialized size (UTF-8 bytes of the compact JSON) of one query result. */
export const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;

export interface TabularLimits {
  /** Maximum number of rows (default {@link DEFAULT_MAX_ROWS}). More is an `McpResultError`. */
  maxRows?: number;
  /** Maximum serialized size in bytes (default {@link DEFAULT_MAX_RESULT_BYTES}). More is an `McpResultError`. */
  maxResultBytes?: number;
}

/**
 * Converts a successful MCP tool result into kohaku's `TabularData`. Throws `McpToolError` for `isError`, and
 * `McpResultError` when the result is not (a wrapper around) a list of objects or exceeds `limits`. The limit
 * errors carry fixed messages that never echo upstream content.
 */
export function toTabularData(
  result: McpCallResult,
  dataVersion: string,
  tool?: string,
  limits: TabularLimits = {},
): TabularData {
  assertToolSucceeded(result, tool);
  const label = tool == null ? "" : ` "${tool}"`;
  const list = findRowList(payloadOf(result));
  if (list == null) {
    throw new McpResultError(
      `MCP tool${label} returned something other than a list of rows ` +
        "(expected an array, or an object with a `rows` array, in structuredContent or as JSON text)",
    );
  }
  const maxRows = limits.maxRows ?? DEFAULT_MAX_ROWS;
  if (list.length > maxRows) {
    throw new McpResultError(`MCP tool${label} returned more than ${maxRows} rows`);
  }
  if (!list.every(isPlainObject)) {
    throw new McpResultError(`MCP tool${label} returned a list whose items are not all objects`);
  }
  const maxBytes = limits.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (new TextEncoder().encode(JSON.stringify(list)).length > maxBytes) {
    throw new McpResultError(`MCP tool${label} returned a result larger than ${maxBytes} bytes`);
  }
  const rows = list as JsonObject[];
  return { columns: inferColumns(rows), rows, dataVersion };
}

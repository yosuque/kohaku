import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import { unwrapNullable } from "./nullable.js";

/** The code of `McpArgumentError`. Not `ACTION_PARAMS_INVALID`, which is the action path's 422 wire code. */
export const MCP_ARGUMENT_INVALID = "MCP_ARGUMENT_INVALID";

/** Default ceiling for the `limit` argument forwarded to a tool (see {@link CoerceOptions.maxLimit}). */
export const DEFAULT_MAX_LIMIT = 1000;

/**
 * A `query://` ref carries its parameters as strings, but an MCP tool declares typed arguments. This is thrown
 * when a string cannot be converted to the type the tool's `inputSchema` asks for. It carries the code
 * `MCP_ARGUMENT_INVALID` (a host-authored validation error: its message is safe to show to the caller). Raised
 * inside `DomainPort.invoke` for a read, the REST host reports it like any failed read: 404 `REF_NOT_FOUND`.
 */
export class McpArgumentError extends Error {
  readonly code = MCP_ARGUMENT_INVALID;
  constructor(message: string) {
    super(message);
    this.name = "McpArgumentError";
  }
}

export interface CoerceOptions {
  /** Ceiling applied to the tool's numeric `limit` argument, however it was supplied (default 1000). */
  maxLimit?: number;
}

/** Reserved ref parameters (data-binding's `KNOWN_RESERVED_PARAMS`) that are never forwarded to a tool as-is. */
const RESERVED = ["_cursor", "_limit", "_sort", "_dir"] as const;

/** Strict JSON-number grammar: no padding, no hex, no `Infinity` / `NaN`. Identical in the Python mirror. */
const NUMBER_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

interface InputSchemaLike {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

function propertyType(inputSchema: InputSchemaLike, name: string): string | undefined {
  const properties = inputSchema.properties;
  if (properties == null || !Object.hasOwn(properties, name)) return undefined;
  const property = unwrapNullable(properties[name]);
  if (typeof property !== "object" || property === null) return undefined;
  const type = (property as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * `_limit` is outside the capability's signed ref, so the one thing it may do is *lower* the signed limit. A
 * negative, zero or fractional value would not (an upstream doing `rows[:limit]` reads -1 as "all but the last
 * row"), so anything but a positive safe integer is refused rather than forwarded. Same grammar as
 * {@link coerceValue}'s numbers, so `"5.0"` and `"1e1"` stay accepted.
 */
function positiveIntegerLimit(value: JsonValue): number {
  const parsed =
    typeof value === "string" ? (NUMBER_PATTERN.test(value) ? Number(value) : Number.NaN) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new McpArgumentError('argument "_limit": expected a positive integer');
  }
  return parsed;
}

function coerceValue(name: string, value: JsonValue, type: string | undefined): JsonValue {
  if (typeof value !== "string") return value;
  switch (type) {
    case "number":
    case "integer": {
      const parsed = NUMBER_PATTERN.test(value) ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed) || (type === "integer" && !Number.isInteger(parsed))) {
        throw new McpArgumentError(
          `argument "${name}": expected ${type === "integer" ? "an integer" : "a number"}`,
        );
      }
      return parsed;
    }
    case "boolean": {
      if (value === "true") return true;
      if (value === "false") return false;
      throw new McpArgumentError(`argument "${name}": expected "true" or "false"`);
    }
    default:
      return value;
  }
}

/**
 * Turns the parameters of a resolved ref into MCP tool arguments:
 *
 * - each string is converted to the `type` the tool's `inputSchema` declares for it (`number`, `integer`,
 *   `boolean`; everything else stays a string), and a value that does not convert throws `McpArgumentError`;
 * - the reserved parameters (`_cursor`, `_limit`, `_sort`, `_dir`) are never forwarded, except that `_limit` is
 *   mapped onto the tool's own numeric `limit` argument when its `inputSchema` declares one. `_limit` is not
 *   covered by the capability's signed ref, so it can only *lower* the signed `limit`: it must be a positive safe
 *   integer (anything else throws `McpArgumentError`, never widens), when both are present the smaller wins, and
 *   `maxLimit` (default 1000) then caps whatever is left;
 * - a value that is not a string (already typed) is kept as is.
 *
 * Pure, so the Python mirror (`kohaku.domain_mcp.coerce`) is pinned to it by the cross-language golden fixture.
 */
export function coerceToolArguments(
  args: JsonObject,
  inputSchema: InputSchemaLike,
  options: CoerceOptions = {},
): JsonObject {
  const out: JsonObject = {};
  const reserved = new Set<string>(RESERVED);
  for (const [name, value] of Object.entries(args)) {
    if (reserved.has(name)) continue;
    out[name] = coerceValue(name, value, propertyType(inputSchema, name));
  }
  const limitType = propertyType(inputSchema, "limit");
  if (limitType === "number" || limitType === "integer") {
    const candidates: number[] = [];
    if (typeof out["limit"] === "number") candidates.push(out["limit"]);
    if (args["_limit"] !== undefined) candidates.push(positiveIntegerLimit(args["_limit"]));
    if (candidates.length > 0) {
      out["limit"] = Math.min(...candidates, options.maxLimit ?? DEFAULT_MAX_LIMIT);
    }
  }
  return out;
}

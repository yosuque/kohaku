import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";

/**
 * A `query://` ref carries its parameters as strings, but an MCP tool declares typed arguments. This is thrown
 * when a string cannot be converted to the type the tool's `inputSchema` asks for. It carries the wire code
 * `ACTION_PARAMS_INVALID` (a host-authored validation error, safe to show to the caller).
 */
export class McpArgumentError extends Error {
  readonly code = "ACTION_PARAMS_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "McpArgumentError";
  }
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
  const property = properties[name];
  if (typeof property !== "object" || property === null) return undefined;
  const type = (property as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
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
 *   mapped onto the tool's own `limit` argument when its `inputSchema` declares one (and then wins over an
 *   explicit `limit`);
 * - a value that is not a string (already typed) is kept as is.
 *
 * Pure, so the Python mirror (`kohaku.domain_mcp.coerce`) is pinned to it by the cross-language golden fixture.
 */
export function coerceToolArguments(args: JsonObject, inputSchema: InputSchemaLike): JsonObject {
  const out: JsonObject = {};
  const reserved = new Set<string>(RESERVED);
  for (const [name, value] of Object.entries(args)) {
    if (reserved.has(name)) continue;
    out[name] = coerceValue(name, value, propertyType(inputSchema, name));
  }
  const limit = args["_limit"];
  const limitType = propertyType(inputSchema, "limit");
  if (limit !== undefined && limitType !== undefined) {
    out["limit"] = coerceValue("limit", limit, limitType);
  }
  return out;
}

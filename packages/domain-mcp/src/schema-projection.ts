import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";

/**
 * The result of projecting an MCP tool's `inputSchema` onto kohaku's closed `paramsSchema` subset
 * (`@kohaku-ui/spec-core`'s `ActionParamsSchemaSchema`).
 */
export interface SchemaProjection {
  /** The projected schema, or null when the input cannot be represented in the subset (`omitted`). */
  schema: JsonObject | null;
  /**
   * Dot-separated paths of the keywords that were dropped on the way (`properties.q.description`). They are
   * annotations or constraints the subset has no equivalent for; dropping one only ever makes the gate more
   * permissive than the upstream server, never stricter. Reported even when the schema was omitted.
   */
  dropped: string[];
  /** True when no schema is attached to the operation (see `reasons`). */
  omitted: boolean;
  /** Dot-separated paths of the constructs that made the schema impossible to represent (`properties.a.anyOf`). */
  reasons: string[];
}

/** Keywords carried over into the subset (type-specific ones are kept only on a node of that type). */
const OBJECT_KEYWORDS = ["properties", "required", "additionalProperties"] as const;
const NUMBER_KEYWORDS = ["minimum", "maximum"] as const;
const STRING_KEYWORDS = ["minLength", "maxLength"] as const;
const ARRAY_KEYWORDS = ["items", "maxItems"] as const;

/**
 * Keywords that are dropped without making the schema unrepresentable: pure annotations, plus constraints
 * kohaku's subset deliberately lacks (`pattern`: regex dialects differ between the TS and Python hosts;
 * `format`: informational). Anything outside this set and outside the kept set is treated as structural
 * (`anyOf`, `$ref`, `not`, ...) and omits the whole schema rather than being silently ignored.
 */
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "default",
  "examples",
  "example",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "pattern",
  "const",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "contentMediaType",
  "contentEncoding",
]);

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

interface Collector {
  dropped: string[];
  reasons: string[];
}

/**
 * Projects an MCP `inputSchema` (arbitrary JSON Schema) onto kohaku's closed `paramsSchema` subset.
 *
 * - Annotation keywords (`description`, `title`, `default`, ...) and constraints the subset lacks (`format`,
 *   `pattern`, ...) are dropped and listed in `dropped`.
 * - Every object node is closed with `additionalProperties: false`, as the subset's only supported form. A
 *   schema that explicitly allows additional properties cannot be represented.
 * - `anyOf` / `oneOf` / `allOf` / `not` / `$ref`, a `type` array, a tuple `items`, a malformed keyword value
 *   or any keyword this function does not know make the schema unrepresentable: `omitted` is true and
 *   `schema` is null, so the operation is exposed without a `paramsSchema`. For an `approve`-tier Action the
 *   approver then sees the raw payload without a host-side structural check.
 *
 * The walk never stops early, so `dropped` and `reasons` are complete and deterministic. The Python mirror
 * (`kohaku.domain_mcp.schema_projection`) is pinned to this output by the cross-language golden fixture.
 */
export function projectInputSchema(inputSchema: unknown): SchemaProjection {
  const collector: Collector = { dropped: [], reasons: [] };
  const projected = projectNode(inputSchema, "", collector, true);
  const omitted = projected === null || collector.reasons.length > 0;
  return {
    schema: omitted ? null : projected,
    dropped: collector.dropped,
    omitted,
    reasons: collector.reasons,
  };
}

function projectNode(node: unknown, path: string, out: Collector, isRoot = false): JsonObject | null {
  if (!isPlainObject(node)) {
    out.reasons.push(path === "" ? "(root)" : path);
    return null;
  }
  const type = node["type"];
  const reasonsBefore = out.reasons.length;
  const validType = typeof type === "string" && SCALAR_TYPES.has(type);

  const result: JsonObject = {};
  if (validType) result["type"] = type;

  // Walk the keywords in the input's own order so `dropped` / `reasons` are deterministic.
  for (const key of Object.keys(node)) {
    const keyPath = join(path, key);
    if (key === "type") continue;
    if (key.startsWith("x-") || DROPPED_KEYWORDS.has(key)) {
      out.dropped.push(keyPath);
      continue;
    }
    if (isKeptKeyword(key)) {
      if (!keywordAppliesTo(key, type)) {
        // JSON Schema ignores a keyword on a node of another type, so dropping it changes nothing.
        out.dropped.push(keyPath);
        continue;
      }
      projectKeyword(key, node[key], keyPath, result, out);
      continue;
    }
    if (key === "enum") {
      projectEnum(node[key], keyPath, result, out);
      continue;
    }
    // Unknown or structural keyword (`anyOf`, `$ref`, `not`, a vendor extension, ...).
    out.reasons.push(keyPath);
  }

  // A missing or unusable `type` is reported only when nothing more specific (a structural keyword such as
  // `anyOf`) already explains why this node cannot be represented. A tool's arguments are always an object, so
  // the root must be one.
  if ((!validType || (isRoot && type !== "object")) && out.reasons.length === reasonsBefore) {
    out.reasons.push(join(path, "type"));
  }
  if (type === "object" && result["additionalProperties"] === undefined) {
    result["additionalProperties"] = false;
  }
  return result;
}

function isKeptKeyword(key: string): boolean {
  return (
    (OBJECT_KEYWORDS as readonly string[]).includes(key) ||
    (NUMBER_KEYWORDS as readonly string[]).includes(key) ||
    (STRING_KEYWORDS as readonly string[]).includes(key) ||
    (ARRAY_KEYWORDS as readonly string[]).includes(key)
  );
}

function keywordAppliesTo(key: string, type: unknown): boolean {
  if ((OBJECT_KEYWORDS as readonly string[]).includes(key)) return type === "object";
  if ((NUMBER_KEYWORDS as readonly string[]).includes(key)) return type === "number" || type === "integer";
  if ((STRING_KEYWORDS as readonly string[]).includes(key)) return type === "string";
  return type === "array";
}

function projectKeyword(key: string, value: unknown, path: string, result: JsonObject, out: Collector): void {
  switch (key) {
    case "properties": {
      if (!isPlainObject(value)) {
        out.reasons.push(path);
        return;
      }
      const properties: Record<string, JsonValue> = {};
      for (const name of Object.keys(value)) {
        const child = projectNode(value[name], join(path, name), out);
        if (child !== null) properties[name] = child;
      }
      result["properties"] = properties;
      return;
    }
    case "required": {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        out.reasons.push(path);
        return;
      }
      result["required"] = value as string[];
      return;
    }
    case "additionalProperties": {
      // Only a literal `false` is representable. `true` / a schema object means "extra keys welcome".
      if (value !== false) {
        out.reasons.push(path);
        return;
      }
      result["additionalProperties"] = false;
      return;
    }
    case "minimum":
    case "maximum": {
      if (!isFiniteNumber(value)) {
        out.reasons.push(path);
        return;
      }
      result[key] = value;
      return;
    }
    case "minLength":
    case "maxLength":
    case "maxItems": {
      if (!isNonNegativeInteger(value)) {
        out.reasons.push(path);
        return;
      }
      result[key] = value;
      return;
    }
    case "items": {
      // A tuple form (an array of schemas) or a boolean schema has no equivalent in the subset.
      const child = projectNode(value, path, out);
      if (child !== null) result["items"] = child;
      return;
    }
    default:
      out.reasons.push(path);
  }
}

function projectEnum(value: unknown, path: string, result: JsonObject, out: Collector): void {
  const primitive = (entry: unknown): entry is string | number | boolean | null =>
    entry === null || typeof entry === "string" || typeof entry === "boolean" || isFiniteNumber(entry);
  if (!Array.isArray(value) || !value.every(primitive)) {
    out.reasons.push(path);
    return;
  }
  result["enum"] = value;
}

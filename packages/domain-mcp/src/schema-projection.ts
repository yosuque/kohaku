import type { JsonObject, JsonValue } from "@kohaku-ui/spec-core";
import { isPlainObject } from "./internal.js";
import { unwrapNullable } from "./nullable.js";

/**
 * The result of projecting an MCP tool's `inputSchema` onto kohaku's closed `paramsSchema` subset
 * (`@kohaku-ui/spec-core`'s `ActionParamsSchemaSchema`).
 */
export interface SchemaProjection {
  /** The projected schema, or null when the input cannot be represented in the subset (`omitted`). */
  schema: JsonObject | null;
  /**
   * Dot-separated paths of the keywords that were dropped on the way (`properties.q.description`). They are
   * annotations, or constraints the subset has no equivalent for (`pattern`, `format`, ...): a dropped
   * constraint makes the gate more permissive than the upstream server for that keyword. The projection can
   * also be *stricter* than the upstream in one way: every object is closed with `additionalProperties: false`,
   * so an extra key the upstream would have accepted is refused. Reported even when the schema was omitted.
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

/** The dropped keywords that are validation constraints (not annotations): losing one loosens the gate. */
const CONSTRAINT_KEYWORDS: ReadonlySet<string> = new Set([
  "pattern",
  "format",
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

/**
 * The dropped constraint keywords in `dropped` (a `SchemaProjection.dropped` list), as bare keyword names in
 * first-appearance order without repeats, plus how many dropped paths were constraints. Annotations
 * (`description`, `title`, `default`, ...) are not constraints and are not counted.
 */
export function droppedConstraints(dropped: string[]): { count: number; keywords: string[] } {
  const keywords: string[] = [];
  let count = 0;
  for (const path of dropped) {
    const keyword = path.slice(path.lastIndexOf(".") + 1);
    if (!CONSTRAINT_KEYWORDS.has(keyword)) continue;
    count += 1;
    if (!keywords.includes(keyword)) keywords.push(keyword);
  }
  return { count, keywords };
}

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
]);

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
 * - A property written as the nullable two-branch `anyOf` (`anyOf: [X, { type: "null" }]`, how Pydantic writes
 *   `Optional[X]`) is projected as the optional property `X`: kept, removed from `required`, and an explicit
 *   null is then rejected by the gate. Any other `anyOf` is unrepresentable.
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
  const nullableNames: string[] = [];
  for (const key of Object.keys(node)) {
    const keyPath = join(path, key);
    if (key === "type") continue;
    // `x-` keys are vendor extensions and are dropped like annotations. A vendor keyword without the `x-`
    // prefix is unknown, not an extension, and falls through to the "unknown keyword" branch below.
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
      nullableNames.push(...projectKeyword(key, node[key], keyPath, result, out));
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
  // A nullable property is optional: take it out of `required` (and drop `required` if that emptied it).
  const required = result["required"];
  if (nullableNames.length > 0 && Array.isArray(required)) {
    const kept = (required as string[]).filter((name) => !nullableNames.includes(name));
    if (kept.length === 0) delete result["required"];
    else result["required"] = kept;
  }
  if (type === "object" && result["additionalProperties"] === undefined) {
    result["additionalProperties"] = false;
  }
  return result;
}

/** A property schema with its nullable `anyOf` wrapper (if any) removed; the wrapper's own keywords are triaged. */
function readProperty(raw: unknown, path: string, out: Collector): { schema: unknown; nullable: boolean } {
  const inner = unwrapNullable(raw);
  if (inner === raw || !isPlainObject(raw)) return { schema: raw, nullable: false };
  for (const key of Object.keys(raw)) {
    if (key === "anyOf") continue;
    const keyPath = join(path, key);
    if (key.startsWith("x-") || DROPPED_KEYWORDS.has(key)) out.dropped.push(keyPath);
    else out.reasons.push(keyPath);
  }
  return { schema: inner, nullable: true };
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

/** Projects one kept keyword into `result`. Returns the names of the nullable properties it saw (`properties` only). */
function projectKeyword(
  key: string,
  value: unknown,
  path: string,
  result: JsonObject,
  out: Collector,
): string[] {
  switch (key) {
    case "properties": {
      if (!isPlainObject(value)) {
        out.reasons.push(path);
        return [];
      }
      const properties: Record<string, JsonValue> = {};
      const nullable: string[] = [];
      for (const name of Object.keys(value)) {
        const propPath = join(path, name);
        const prop = readProperty(value[name], propPath, out);
        const child = projectNode(prop.schema, propPath, out);
        if (child !== null) properties[name] = child;
        if (prop.nullable) nullable.push(name);
      }
      result["properties"] = properties;
      return nullable;
    }
    case "required": {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        out.reasons.push(path);
        return [];
      }
      result["required"] = value as string[];
      return [];
    }
    case "additionalProperties": {
      // Only a literal `false` is representable. `true` / a schema object means "extra keys welcome".
      if (value !== false) {
        out.reasons.push(path);
        return [];
      }
      result["additionalProperties"] = false;
      return [];
    }
    case "minimum":
    case "maximum": {
      if (!isFiniteNumber(value)) {
        out.reasons.push(path);
        return [];
      }
      result[key] = value;
      return [];
    }
    case "minLength":
    case "maxLength":
    case "maxItems": {
      if (!isNonNegativeInteger(value)) {
        out.reasons.push(path);
        return [];
      }
      result[key] = value;
      return [];
    }
    case "items": {
      // A tuple form (an array of schemas) or a boolean schema has no equivalent in the subset.
      const child = projectNode(value, path, out);
      if (child !== null) result["items"] = child;
      return [];
    }
    default:
      out.reasons.push(path);
      return [];
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

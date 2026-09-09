import { z } from "zod";

type JsonNode = Record<string, unknown>;

/**
 * Reconstructs a propsSchema from a promotion draft's paramsJsonSchema (object + primitive supported).
 * A total conversion that drops unsupported structures to z.unknown(), so it never throws at
 * publish / startup time.
 *
 * Supported range: the properties of a type:"object" schema (string(+enum) / number / integer /
 * boolean / one-level-nested object / primitive array), required, and default. Any other property is
 * dropped to z.unknown().optional(). If the whole schema is not an object, it falls back to loose
 * z.record-based validation (arbitrary key → unknown).
 *
 * The conversion result passes registry's toPropsJsonSchema (unrepresentable:"throw") without throwing
 * (= it upholds the precondition of the startup-hardening buildableEntries / defineComponent
 * JSON-representability check).
 */
export function propsSchemaFromJsonSchema(schema: unknown): z.ZodType<Record<string, unknown>> {
  if (!isObjectSchema(schema)) {
    // Non-object / missing: make no structural claim and fall back to loose validation (arbitrary key → unknown).
    return z.record(z.string(), z.unknown());
  }
  return buildObject(schema, 0);
}

/** Whether this is a JSON Schema that is type:"object" and has properties. */
function isObjectSchema(schema: unknown): schema is JsonNode {
  return isPlainObject(schema) && schema["type"] === "object" && isPlainObject(schema["properties"]);
}

/** Converts an object schema to z.object. depth is used to decide whether one-level nesting is allowed. */
function buildObject(node: JsonNode, depth: number): z.ZodObject {
  const properties = node["properties"] as Record<string, unknown>;
  const requiredList = Array.isArray(node["required"]) ? (node["required"] as unknown[]) : [];
  const required = new Set(requiredList.filter((k): k is string => typeof k === "string"));
  const shape: Record<string, z.ZodType> = {};
  for (const [key, propNode] of Object.entries(properties)) {
    shape[key] = convertProp(propNode, required.has(key), depth);
  }
  return z.object(shape);
}

/** Converts one property and applies default / optional. Unsupported cases become z.unknown().optional(). */
function convertProp(propNode: unknown, isRequired: boolean, depth: number): z.ZodType {
  const base = baseSchema(propNode, depth);
  if (base == null) return z.unknown().optional();
  if (isPlainObject(propNode) && "default" in propNode) {
    // Anything with a default gets a default (= optional) regardless of whether it is required.
    return base.default(propNode["default"] as never);
  }
  return isRequired ? base : base.optional();
}

/** Base schema for a primitive / one-level object / primitive array. Unsupported cases are null. */
function baseSchema(propNode: unknown, depth: number): z.ZodType | null {
  if (!isPlainObject(propNode)) return null;
  const primitive = primitiveSchema(propNode);
  if (primitive != null) return primitive;
  if (propNode["type"] === "object") {
    // Only one-level nesting is supported. Deeper objects are accepted loosely (null → z.unknown().optional()).
    return depth >= 1 ? null : buildObject(propNode, depth + 1);
  }
  if (propNode["type"] === "array") {
    const element = primitiveSchema(propNode["items"]);
    return element != null ? z.array(element) : null;
  }
  return null;
}

/** Base schema for string(+enum) / number / integer / boolean. Anything else is null. */
function primitiveSchema(node: unknown): z.ZodType | null {
  if (!isPlainObject(node)) return null;
  switch (node["type"]) {
    case "string": {
      const values = stringEnum(node["enum"]);
      return values != null ? z.enum(values) : z.string();
    }
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    default:
      return null;
  }
}

function isPlainObject(v: unknown): v is JsonNode {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** If it is a non-empty string enum array, returns it in a form that can be passed to z.enum. */
function stringEnum(v: unknown): [string, ...string[]] | null {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string")) return null;
  return v as [string, ...string[]];
}

import { z } from "zod";
import type { ComponentDefinition, PropsJsonSchema } from "./types.js";

/** Plain JSON Schema derived from the catalog's "true schema" (draft 2020-12, with $ref inlined) */
export function toPropsJsonSchema(def: ComponentDefinition): PropsJsonSchema {
  return z.toJSONSchema(def.propsSchema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    reused: "inline",
  }) as PropsJsonSchema;
}

const propsJsonSchemaCache = new WeakMap<ComponentDefinition, PropsJsonSchema>();

/**
 * Memoized toPropsJsonSchema, keyed by the ComponentDefinition object itself. A definition object is
 * created once (per component type, whether in the core catalog or a product/tenant contribution) and
 * reused as-is by every ResolvedCatalog that includes it, so the derived JSON Schema — a pure function
 * of the immutable propsSchema — never needs to be recomputed for the same def. Callers that rebuild a
 * schema per request (the /catalog route, buildGenerationSchema) benefit without any cache invalidation
 * logic: a WeakMap key that goes out of scope (the def is no longer referenced anywhere) is collected
 * automatically.
 */
export function cachedPropsJsonSchema(def: ComponentDefinition): PropsJsonSchema {
  const cached = propsJsonSchemaCache.get(def);
  if (cached != null) return cached;
  const computed = toPropsJsonSchema(def);
  propsJsonSchemaCache.set(def, computed);
  return computed;
}

type JsonSchemaNode = Record<string, unknown>;

/**
 * Deterministic conversion into the schema presented to the LLM (aligned to the provider lowest common
 * denominator for structured output):
 * - object: make every property required and turn originally-optional ones into anyOf [orig, null]
 *   (because OpenAI strict mode does not support optional and requires all properties; this assumes a
 *    two-stage approach of removing null after generation and re-validating against the true schema)
 * - force additionalProperties: false
 * - remove default / $schema (for Gemini responseSchema compatibility)
 */
export function toGenerationPropsSchema(schema: PropsJsonSchema): PropsJsonSchema {
  // A JSON Schema is a JSON value, so it can be safely deep-cloned via a JSON round-trip
  return walk(JSON.parse(JSON.stringify(schema)) as JsonSchemaNode) as PropsJsonSchema;
}

const generationPropsSchemaCache = new WeakMap<ComponentDefinition, PropsJsonSchema>();

/**
 * Memoized `toGenerationPropsSchema(cachedPropsJsonSchema(def))`, keyed by ComponentDefinition (same
 * rationale as cachedPropsJsonSchema). buildGenerationSchema calls this once per component type on
 * every L1 generation attempt; without memoization that repeats a Zod→JSON-Schema conversion, a full
 * JSON round-trip deep clone, and a recursive walk for every attempt of every compose, for output that
 * never changes for a given def.
 */
export function cachedGenerationPropsSchema(def: ComponentDefinition): PropsJsonSchema {
  const cached = generationPropsSchemaCache.get(def);
  if (cached != null) return cached;
  const computed = toGenerationPropsSchema(cachedPropsJsonSchema(def));
  generationPropsSchemaCache.set(def, computed);
  return computed;
}

function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk);
  if (node == null || typeof node !== "object") return node;
  const n = { ...(node as JsonSchemaNode) };
  delete n["default"];
  delete n["$schema"];

  if (n["type"] === "object" && n["properties"] != null && typeof n["properties"] === "object") {
    const props = n["properties"] as Record<string, unknown>;
    const required = new Set((n["required"] as string[] | undefined) ?? []);
    const newProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      const transformed = walk(value);
      newProps[key] = required.has(key) ? transformed : { anyOf: [transformed, { type: "null" }] };
    }
    n["properties"] = newProps;
    n["required"] = Object.keys(newProps);
    n["additionalProperties"] = false;
    return n;
  }

  for (const key of ["items", "anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (n[key] != null) n[key] = walk(n[key]);
  }
  return n;
}

/** Removes null-valued properties from the generation result (the "null = omitted" convention). A precursor to re-validating against the true schema. */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as T;
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNulls(v)]),
    ) as T;
  }
  return value;
}

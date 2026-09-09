import type { z } from "zod";

/**
 * Minimal structure for walking to a Zod field's base type name (Zod 4's public `.def`).
 * Wrappers (default / optional / nullable, etc.) have innerType; a base (number / string / enum, etc.) does not.
 */
interface ZodDefLike {
  readonly type: string;
  readonly innerType?: unknown;
}

/** Strips wrappers and returns the base schema instance (the first node without innerType). */
function unwrapBase(schema: unknown): unknown {
  let cur: unknown = schema;
  for (let depth = 0; depth < 16; depth++) {
    const def = (cur as { def?: ZodDefLike } | null | undefined)?.def;
    if (def == null) return null;
    if (def.innerType != null) {
      cur = def.innerType;
      continue;
    }
    return cur;
  }
  return null;
}

/** Type name of the base schema (number / string / enum, etc.). null if it cannot be obtained. */
function baseType(schema: unknown): string | null {
  const def = (unwrapBase(schema) as { def?: ZodDefLike } | null)?.def;
  return def?.type ?? null;
}

/**
 * Derives the valueType for client-side coerce from a Zod field.
 * For z.coerce.number(...), stripping the default / optional wrappers yields a base of "number".
 * Everything else (enum / string, etc.) is treated as a string. Because it is derived from the
 * same source as the server-side coerce (z.coerce.number), the client coerce (whether "2026"→2026)
 * and the server validation agree by definition.
 */
export function facetValueType(schema: z.ZodType): "number" | "string" {
  return baseType(schema) === "number" ? "number" : "string";
}

/**
 * Returns the value members of an enum-kind field (for facet derivation when options is omitted).
 * null if it is not an enum. Zod 4's ZodEnum instance exposes `options` (an array of values).
 */
export function enumValuesOf(schema: z.ZodType): string[] | null {
  const base = unwrapBase(schema);
  if ((base as { def?: ZodDefLike } | null)?.def?.type !== "enum") return null;
  const options = (base as { options?: unknown }).options;
  if (Array.isArray(options) && options.every((v) => typeof v === "string")) {
    return options as string[];
  }
  return null;
}

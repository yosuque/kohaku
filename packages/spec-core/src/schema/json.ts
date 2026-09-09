import { z } from "zod";

/**
 * Only JSON values may be placed in a UI Spec's props / params.
 * Functions, Date, and undefined are excluded at the type level (a Spec is "data, not code").
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Upper bound on JsonObjectSchema's nesting depth (the top-level object itself = depth 1). Guards the
 * recursive canonicalStringify (cache-key / spec-hash computation) and lineage persistence downstream of
 * request bodies validated by JsonObjectSchema (host-rest's params / payload fields) against a
 * pathologically deep — but otherwise schema-valid — JSON payload.
 */
export const MAX_JSON_OBJECT_DEPTH = 32;

/**
 * True once `value` is nested deeper than `limit` (starting at `depth`, the top-level object = 1). Only
 * descending into an array/object counts toward depth — a scalar leaf (string/number/boolean/null) never
 * does, since it cannot nest any further. Recursion itself is bounded to `limit + 1` stack frames in the
 * worst case (an array/object stops descending the instant its own depth exceeds the limit, before visiting
 * its children), so a pathologically deep payload cannot blow the stack while being measured.
 */
function exceedsMaxJsonDepth(value: JsonValue, limit: number, depth: number): boolean {
  if (Array.isArray(value)) {
    if (depth > limit) return true;
    return value.some((item) => exceedsMaxJsonDepth(item, limit, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth > limit) return true;
    return Object.values(value).some((item) => exceedsMaxJsonDepth(item, limit, depth + 1));
  }
  return false;
}

export const JsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() =>
  z.record(z.string(), JsonValueSchema).superRefine((value, ctx) => {
    if (exceedsMaxJsonDepth(value, MAX_JSON_OBJECT_DEPTH, 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `object nesting exceeds the maximum depth (${MAX_JSON_OBJECT_DEPTH})`,
      });
    }
  }),
);

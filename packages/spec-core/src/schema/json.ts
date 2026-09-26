import { z } from "zod";

/**
 * Only JSON values may be placed in a UI Spec's props / params.
 * Functions, Date, and undefined are excluded at the type level (a Spec is "data, not code").
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Upper bound on JsonValueSchema / JsonObjectSchema's nesting depth (the value itself -- or, for
 * JsonObjectSchema, the top-level object -- = depth 1). Guards the recursive canonicalStringify (cache-key /
 * spec-hash computation) and lineage persistence downstream of external input validated by these schemas
 * (host-rest's params / payload fields, host-mcp-apps' tool inputs, a persisted Spec read back from storage)
 * against a pathologically deep -- but otherwise schema-valid -- JSON payload.
 */
export const MAX_JSON_OBJECT_DEPTH = 32;

/**
 * True once `value` is nested deeper than `limit` (starting at `depth`, the top-level value = 1). Only
 * descending into an array/object counts toward depth — a scalar leaf (string/number/boolean/null) never
 * does, since it cannot nest any further. Recursion itself is bounded to `limit + 1` stack frames in the
 * worst case (an array/object stops descending the instant its own depth exceeds the limit, before visiting
 * its children), so a pathologically deep payload cannot blow the stack while being measured.
 *
 * `value` is accepted as `unknown` (not narrowed to `JsonValue`) so it can run directly on a raw
 * `JSON.parse` result before any schema has vouched for its shape -- see host-rest's `parseBody`, which uses
 * it as a second, schema-independent line of defense on the whole request body.
 */
export function exceedsMaxJsonDepth(value: unknown, limit: number, depth = 1): boolean {
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

/**
 * The actual recursive structural definition of a JSON value (array / record mutual recursion via z.lazy).
 * Never exported directly: parsing an arbitrarily deep value against this schema recurses through zod's own
 * `z.union`/`z.array`/`z.record` machinery one stack frame per nesting level, so an input whose depth has not
 * already been bounded (by `jsonDepthGuard` below) can overflow the stack before either schema's own checks
 * get a chance to reject it -- that ordering bug (depth was previously checked only in a `superRefine` that
 * runs *after* this same unbounded recursive parse) is exactly what let a payload nested a few thousand
 * levels deep turn into an uncaught `RangeError` instead of a `ZodError`. `JsonValueSchema` / `JsonObjectSchema`
 * below pipe into this only once their own up-front guard has confirmed the value is shallow enough for the
 * recursion to be safe.
 */
const RawJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(RawJsonValueSchema),
    z.record(z.string(), RawJsonValueSchema),
  ]),
);

/**
 * Rejects a value nested deeper than `limit` before it ever reaches a schema that would recurse over its
 * structure. Built on `z.unknown()` (whose own structural parse is a no-op -- it accepts anything without
 * recursing), so the only work done here is `exceedsMaxJsonDepth`'s bounded, non-Zod recursion; `.pipe()`
 * only runs the following schema once this one produces no issues (zod/v4's ZodPipe short-circuits a failing
 * left-hand schema -- see `handlePipeResult` in zod's core), so a too-deep value is rejected without the
 * recursive schema ever seeing it.
 */
function jsonDepthGuard(limit: number): z.ZodType<unknown> {
  return z.unknown().superRefine((value, ctx) => {
    if (exceedsMaxJsonDepth(value, limit)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `object nesting exceeds the maximum depth (${limit})`,
      });
    }
  });
}

/**
 * Any JSON value (string / number / boolean / null / array / object), bounded to MAX_JSON_OBJECT_DEPTH levels
 * of nesting from itself. This is the schema every direct external-input use of "a JSON value" should import
 * (component props, state-predicate / event-payload / Intent-params / Spec-state values, ...) -- depth is
 * checked up front (see `jsonDepthGuard`) rather than in a post-hoc `superRefine`, so importing this symbol
 * is enough to close the recursion-depth gap at every one of those call sites without touching them
 * individually.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = jsonDepthGuard(MAX_JSON_OBJECT_DEPTH).pipe(RawJsonValueSchema);

/**
 * A JSON object (the top-level value must itself be a record), matching JsonValueSchema's depth bound (the
 * object itself is depth 1). Piped directly into RawJsonValueSchema's record variant rather than through the
 * exported JsonValueSchema: this schema's own up-front guard already bounds the whole tree, so re-running
 * JsonValueSchema's per-property guard on every value would just repeat the same (already-satisfied) check.
 */
export const JsonObjectSchema: z.ZodType<JsonObject> = jsonDepthGuard(MAX_JSON_OBJECT_DEPTH).pipe(
  z.record(z.string(), RawJsonValueSchema),
);

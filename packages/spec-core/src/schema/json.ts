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
 * The recursive structural definition of a JSON value (array / record mutual recursion via z.lazy). Never
 * exported directly: parsing an arbitrarily deep value against this schema recurses through zod's own
 * `z.union`/`z.array`/`z.record` machinery one stack frame per nesting level, so an input whose depth has not
 * already been bounded (by `withDepthGuard` below) can overflow the stack before either schema's own checks
 * get a chance to reject it -- that ordering bug (depth was previously checked only in a `superRefine` that
 * runs *after* this same unbounded recursive parse) is exactly what let a payload nested a few thousand
 * levels deep turn into an uncaught `RangeError` instead of a `ZodError`. `JsonValueSchema` / `JsonObjectSchema`
 * below only reach this once `withDepthGuard` has confirmed the value is shallow enough for the recursion to
 * be safe. This is also, unchanged, the schema `pnpm --filter @kohaku-ui/spec run generate-schemas` renders
 * for every JsonValue-typed field -- see `withDepthGuard`'s doc comment for why the guard wrapping it does
 * not show up in the generated JSON Schema.
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
 * Wraps `schema` with a depth precheck that runs before `schema`'s own (possibly recursive) structural parse
 * ever does. Built with `z.preprocess` rather than the more direct `z.unknown().superRefine(...).pipe(schema)`:
 * both compile to a `ZodPipe` whose left-hand side aborts the pipe on a reported issue before `schema` (the
 * right-hand side) ever runs (zod v4's `handlePipeResult`: a failing left side short-circuits), so either
 * shape is equally safe at runtime -- a too-deep value never reaches the recursive union/record parse that
 * would otherwise overflow the stack (see MAX_JSON_OBJECT_DEPTH's doc comment for the incident this guards
 * against).
 *
 * The two differ in what `z.toJSONSchema(..., { io: "input" })` renders them as, which is why `z.preprocess`
 * is the one used here: a pipe's left-hand side is normally what represents the whole pipe in `io: "input"`
 * mode, but zod special-cases a pipe whose left side is a `transform` (exactly what `z.preprocess(fn, schema)`
 * builds) to resolve to its *right*-hand side instead -- see `zod/v4/classic/in-out.js`: "a bare transform
 * validates nothing, so the schema it feeds is the real input side". A `superRefine`-based left side has no
 * such carve-out (it is a refinement, not a transform), so it would keep the JSON Schema conversion pointed
 * at itself -- an unconstrained `{}`, since a `superRefine` predicate has no JSON Schema equivalent -- instead
 * of at `schema`. Using `z.preprocess` keeps `spec/schemas/*.schema.json` (a published protocol artifact)
 * byte-identical to `schema`'s own shape, rather than collapsing every JsonValue-typed field to `{}`.
 *
 * One follow-on side effect: zod also treats *any* schema containing a `transform` anywhere within it as
 * disqualifying an enclosing `.default()` from showing its default value in `io: "input"` mode (a separate,
 * blunter heuristic -- see `isTransforming` in zod's to-json-schema.js), which would otherwise silently drop
 * the `default` on a field like a component's `props` (`z.record(z.string(), JsonValueSchema).default({})`).
 * `spec/scripts/generate-schemas.ts` restores it via that same `override` hook -- see its
 * `restoreDefaultsStrippedByTheDepthGuardsTransform` for why that is safe to do unconditionally here (our
 * transform never changes the value, only validates it).
 */
function withDepthGuard<T>(limit: number, schema: z.ZodType<T>): z.ZodType<T> {
  return z.preprocess((value, ctx) => {
    if (exceedsMaxJsonDepth(value, limit)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `object nesting exceeds the maximum depth (${limit})`,
      });
      return z.NEVER;
    }
    return value;
  }, schema);
}

/**
 * Any JSON value (string / number / boolean / null / array / object), bounded to MAX_JSON_OBJECT_DEPTH levels
 * of nesting from itself. This is the schema every direct external-input use of "a JSON value" should import
 * (component props, state-predicate / event-payload / Intent-params / Spec-state values, ...) -- depth is
 * checked up front (see `withDepthGuard`) rather than in a post-hoc `superRefine`, so importing this symbol
 * is enough to close the recursion-depth gap at every one of those call sites without touching them
 * individually.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = withDepthGuard(
  MAX_JSON_OBJECT_DEPTH,
  RawJsonValueSchema,
);

/**
 * A JSON object (the top-level value must itself be a record), matching JsonValueSchema's depth bound (the
 * object itself is depth 1). Wraps `z.record(z.string(), RawJsonValueSchema)` directly rather than the
 * exported JsonValueSchema: this schema's own guard already bounds the whole tree, so re-running
 * JsonValueSchema's per-property guard on every value would just repeat the same (already-satisfied) check.
 */
export const JsonObjectSchema: z.ZodType<JsonObject> = withDepthGuard(
  MAX_JSON_OBJECT_DEPTH,
  z.record(z.string(), RawJsonValueSchema),
);

import { z } from "zod";
import { JsonValueSchema } from "./json.js";

/**
 * Client-local state and conditional display (SPEC §2.1 / §2.2 [Draft], kohaku >= 0.2).
 *
 * state is a key→value map closed within the Renderer and is not sent to the server (upholding the
 * SPEC-EVT-002 control boundary). visibleWhen is a predicate that references state to declaratively
 * toggle a component's visibility. Predicate evaluation is handled by the environment-neutral pure
 * function predicate.ts, sharing semantics with non-React renderers too.
 *
 * Predicates are formed as a backward-compatible union:
 * - Leaf: `{ ref: "$state.<key>", <comparison> }`. The comparison is **exactly one** of eq / ne / in /
 *   gt / lt / gte / lte / exists (guaranteeing evaluation uniqueness). gt/lt/gte/lte are numeric
 *   comparisons (always false if the state value is non-numeric); exists is the boolean of whether the
 *   state value is other than null/undefined.
 * - Compound: `{ all: [predicates…] }` (conjunction) / `{ any: [predicates…] }` (disjunction) /
 *   `{ not: predicate }` (negation). Recursive and nestable. Sensible upper bounds on depth and element
 *   count (depth 8, array 16) are set, and exceeding them is a validation error.
 */

/** A state key name. A single identifier word (leading letter + alphanumerics/underscore, max 64 chars). */
export const StateKeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);

/** A state reference. `$state.<key>` form, used for the ref of a visibleWhen leaf and for extracting the inner key. */
export const StateRefSchema = z.string().regex(/^\$state\.[a-zA-Z][a-zA-Z0-9_]{0,63}$/);

/** The max nesting depth of a compound predicate (a single leaf counts as depth 1). Prevents evaluation blow-up from excessive nesting. */
export const MAX_PREDICATE_DEPTH = 8;
/** The max length of the element array for all / any. A sensible upper bound to prevent enumeration explosion. */
export const MAX_PREDICATE_ITEMS = 16;

/** The comparison keys usable in a leaf predicate. Exactly one may be specified. */
const LEAF_COMPARISON_KEYS = ["eq", "ne", "in", "gt", "lt", "gte", "lte", "exists"] as const;

/**
 * A leaf predicate. Consists of ref (the state key referenced) + exactly one comparison.
 * - eq / ne: canonical equality of JSON values (null is a valid comparison target; distinguished from
 *   unspecified undefined).
 * - in: canonical equality with any element of a JSON value array.
 * - gt / lt / gte / lte: numeric comparison (false if the state value is not a number).
 * - exists: whether the state value is other than null/undefined (true = present / false = absent).
 * strict: rejects, rather than strips, unknown-key contamination (mixing with compound keys, etc.),
 * preventing ambiguity in the union's branch selection.
 */
export const LeafPredicateSchema = z
  .object({
    ref: StateRefSchema,
    eq: JsonValueSchema.optional(),
    ne: JsonValueSchema.optional(),
    in: z.array(JsonValueSchema).optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
    gte: z.number().optional(),
    lte: z.number().optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine((v) => LEAF_COMPARISON_KEYS.filter((k) => v[k] !== undefined).length === 1, {
    message: "a visibleWhen leaf must specify exactly one of eq / ne / in / gt / lt / gte / lte / exists",
  });

export type LeafPredicate = z.infer<typeof LeafPredicateSchema>;

/** A predicate node (leaf or compound). Because it is a recursive type via z.lazy, the type is hand-written and annotated. */
export type VisibleWhen =
  | LeafPredicate
  | { all: VisibleWhen[] }
  | { any: VisibleWhen[] }
  | { not: VisibleWhen };

/**
 * The recursive union of predicate nodes (the bare form without depth validation), never exported directly:
 * parsing an arbitrarily deep value against this schema recurses through zod's own `z.union`/`z.lazy`
 * machinery one stack frame per nesting level, so an input whose depth has not already been bounded (by
 * `predicateDepth` + the preprocess below) can overflow the stack before `VisibleWhenSchema`'s own depth
 * limit gets a chance to reject it -- the same ordering bug as spec-core's JsonObjectSchema (see json.ts's
 * MAX_JSON_OBJECT_DEPTH doc comment for that incident), here for a chain of `{"not":{"not":...}}` instead.
 * The element count of all / any is enforced by MAX_PREDICATE_ITEMS; strict rejects mixing of compound keys.
 */
const RawPredicateNodeSchema: z.ZodType<VisibleWhen> = z.lazy(() =>
  z.union([
    LeafPredicateSchema,
    z.object({ all: z.array(RawPredicateNodeSchema).min(1).max(MAX_PREDICATE_ITEMS) }).strict(),
    z.object({ any: z.array(RawPredicateNodeSchema).min(1).max(MAX_PREDICATE_ITEMS) }).strict(),
    z.object({ not: RawPredicateNodeSchema }).strict(),
  ]),
);

/**
 * The nesting depth of a predicate-shaped value (a leaf, or anything not recognized as a compound shape,
 * counts as depth 1), capped at `limit + 1`: recursion stops the instant depth would exceed `limit`, so this
 * can run safely on an arbitrarily deep -- and not yet schema-validated -- value before `RawPredicateNodeSchema`
 * ever does (mirrors `exceedsMaxJsonDepth` in json.ts). Takes `unknown` (not `VisibleWhen`) so it can run
 * ahead of validation; a compound key's array is walked with a plain loop rather than `Math.max(...array)`,
 * since a raw, not-yet-validated `all`/`any` array is not yet bounded by MAX_PREDICATE_ITEMS and a large
 * enough one would itself overflow `Math.max`'s argument-spread stack. The returned depth is exact up to
 * `limit + 1` (accurate for the common near-boundary case, e.g. reporting exactly 9 for a limit of 8) and
 * only a lower bound beyond that (a payload nested 100000 levels deep is also reported as `limit + 1`) --
 * enough to always know it exceeds the limit, without ever counting an unbounded input exactly.
 */
function predicateDepth(value: unknown, limit: number, depth = 1): number {
  if (depth > limit) return depth;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return depth;
  const obj = value as Record<string, unknown>;
  const children = Array.isArray(obj.all) ? obj.all : Array.isArray(obj.any) ? obj.any : null;
  if (children != null && children.length > 0) {
    let max = depth;
    for (const child of children) {
      const childDepth = predicateDepth(child, limit, depth + 1);
      if (childDepth > max) max = childDepth;
      if (max > limit) break;
    }
    return max;
  }
  if ("not" in obj) return predicateDepth(obj.not, limit, depth + 1);
  return depth;
}

/**
 * The conditional-display predicate schema. Depth is checked up front (mirrors json.ts's `withDepthGuard`):
 * `z.preprocess` builds a `ZodPipe` whose depth-checking left side aborts the pipe -- before
 * `RawPredicateNodeSchema` (the right side) ever runs -- on a reported issue (zod v4's `handlePipeResult`),
 * and is resolved through to that right side's own shape by `z.toJSONSchema(..., { io: "input" })` (see
 * json.ts's `withDepthGuard` doc comment for why a `z.preprocess`-shaped guard, specifically, keeps
 * `spec/schemas/*.schema.json` byte-identical rather than collapsing to `{}`).
 */
export const VisibleWhenSchema: z.ZodType<VisibleWhen> = z.preprocess((value, ctx) => {
  const depth = predicateDepth(value, MAX_PREDICATE_DEPTH);
  if (depth > MAX_PREDICATE_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `visibleWhen is nested too deeply (depth ${depth} > limit ${MAX_PREDICATE_DEPTH})`,
    });
    return z.NEVER;
  }
  return value;
}, RawPredicateNodeSchema);

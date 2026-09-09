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
 * The recursive union of predicate nodes (the bare form without depth validation). The element count of
 * all / any is enforced by MAX_PREDICATE_ITEMS, and the nesting depth is checked by the superRefine on
 * VisibleWhenSchema. strict rejects mixing of compound keys.
 */
const PredicateNodeSchema: z.ZodType<VisibleWhen> = z.lazy(() =>
  z.union([
    LeafPredicateSchema,
    z.object({ all: z.array(PredicateNodeSchema).min(1).max(MAX_PREDICATE_ITEMS) }).strict(),
    z.object({ any: z.array(PredicateNodeSchema).min(1).max(MAX_PREDICATE_ITEMS) }).strict(),
    z.object({ not: PredicateNodeSchema }).strict(),
  ]),
);

/** The nesting depth of a predicate tree (leaf = 1). */
function predicateDepth(pred: VisibleWhen): number {
  if ("all" in pred) return 1 + Math.max(...pred.all.map(predicateDepth));
  if ("any" in pred) return 1 + Math.max(...pred.any.map(predicateDepth));
  if ("not" in pred) return 1 + predicateDepth(pred.not);
  return 1;
}

/**
 * The conditional-display predicate schema. The recursive union with nesting-depth upper-bound
 * validation layered on top. The array element count is enforced by .max within the union; the depth is
 * checked here by traversing the whole tree once.
 */
export const VisibleWhenSchema = PredicateNodeSchema.superRefine((pred, ctx) => {
  const depth = predicateDepth(pred);
  if (depth > MAX_PREDICATE_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `visibleWhen is nested too deeply (depth ${depth} > limit ${MAX_PREDICATE_DEPTH})`,
    });
  }
});

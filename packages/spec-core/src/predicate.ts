import { canonicalStringify } from "./canonical-json.js";
import type { JsonValue } from "./schema/json.js";
import type { LeafPredicate, VisibleWhen } from "./schema/state.js";

/**
 * A pure, environment-neutral function that evaluates a visibleWhen predicate against state.
 * Leaf comparison is done by equality of canonicalStringify outputs — matching deterministically down
 * to key order and array/object structure (in takes this equality per element). Compound predicates
 * (all / any / not) fold recursively. The comparison logic is centralized here so React and non-React
 * renderers share identical semantics.
 *
 * When state has no initial value for the key (undefined), it never matches the comparison value
 * (including null): canonicalStringify(undefined) returns JS undefined, which is always non-equal to
 * strings like `"null"`. This distinguishes "unspecified undefined" from "value is null". Note that an
 * unknown key in a VisibleWhen leaf ref is forbidden up front by STATE_REF_UNKNOWN, so current is never
 * undefined at actual render time.
 */
export function evaluateVisibleWhen(pred: VisibleWhen, state: Readonly<Record<string, JsonValue>>): boolean {
  if ("all" in pred) return pred.all.every((p) => evaluateVisibleWhen(p, state));
  if ("any" in pred) return pred.any.some((p) => evaluateVisibleWhen(p, state));
  if ("not" in pred) return !evaluateVisibleWhen(pred.not, state);
  return evaluateLeaf(pred, state);
}

/** Evaluates a leaf predicate (ref + exactly one comparison). */
function evaluateLeaf(pred: LeafPredicate, state: Readonly<Record<string, JsonValue>>): boolean {
  const key = pred.ref.slice("$state.".length);
  const current = state[key];
  if (pred.eq !== undefined) return sameJson(current, pred.eq);
  if (pred.ne !== undefined) return !sameJson(current, pred.ne);
  if (pred.in !== undefined) return pred.in.some((v) => sameJson(current, v));
  // Numeric comparison: always false if the state value is not a number (undefined / null / string, etc.).
  if (pred.gt !== undefined) return typeof current === "number" && current > pred.gt;
  if (pred.lt !== undefined) return typeof current === "number" && current < pred.lt;
  if (pred.gte !== undefined) return typeof current === "number" && current >= pred.gte;
  if (pred.lte !== undefined) return typeof current === "number" && current <= pred.lte;
  // Existence check: matches whether the state value is other than null/undefined against exists' boolean.
  if (pred.exists !== undefined) return (current !== undefined && current !== null) === pred.exists;
  // Unreachable because of refine, but default to visible for type exhaustiveness.
  return true;
}

/**
 * Enumerates the state keys a predicate tree references, in traversal order (including duplicates).
 * A pure function that lets validate.ts's STATE_REF_UNKNOWN check (referenced keys must have an initial
 * value in spec.state) inspect every leaf even for compound predicates.
 */
export function collectStateRefs(pred: VisibleWhen): string[] {
  if ("all" in pred) return pred.all.flatMap(collectStateRefs);
  if ("any" in pred) return pred.any.flatMap(collectStateRefs);
  if ("not" in pred) return collectStateRefs(pred.not);
  return [pred.ref.slice("$state.".length)];
}

function sameJson(a: JsonValue | undefined, b: JsonValue): boolean {
  // When a is undefined, canonicalStringify returns JS undefined, which does not match the string
  // representation of b (always a defined JSON value). This is what guarantees the undefined/null
  // distinction.
  return canonicalStringify(a) === canonicalStringify(b);
}

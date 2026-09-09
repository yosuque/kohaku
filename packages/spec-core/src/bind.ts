import { formatQueryRef, parseQueryRef } from "./query-ref.js";
import type { DataRef } from "./schema/component.js";
import type { JsonValue } from "./schema/json.js";

/**
 * Environment-neutral pure functions (peers of predicate.ts) that resolve two-way binding
 * ($state → $ref parameter binding, kohaku >= 0.2 [Draft]). React and non-React renderers share the
 * semantics.
 *
 * data.bind is a declarative sidecar that "replaces specific $ref parameters with $state values to
 * form the effective ref". $ref is the **concrete canonical URI of the initial variant**, with the
 * bound parameters filled by their initial $state values, so in the initial state (state still at its
 * initial values) the effective ref equals $ref itself.
 */

/**
 * Returns the effective ref with the binding resolved against the current $state.
 *
 * - If bind is absent / empty, returns $ref as-is (byte-preserving the existing no-binding behavior).
 * - Even with bind, if every replaced parameter value matches the $ref initial value ($state still at
 *   its initial values), returns $ref as-is. This makes "for the initial variant, effective ref ===
 *   node.data.$ref" hold, so freshness matching (useBoundData) can still match the initial variant
 *   against refVersions / dataVersion (only client-originated other variants skip matching).
 * - If any parameter changed from its initial value, parses, swaps the value, and returns the
 *   **canonicalized** form. This canonical form matches enumerateBindVariants (capability enumeration)
 *   and the host's base-ref verification.
 *
 * The replacement value is `String(state[$state key])` (query parameters are strings). If state has no
 * such key (undefined), the initial value = $ref is preserved.
 */
export function resolveBoundRef(dataRef: DataRef, state: Readonly<Record<string, JsonValue>>): string {
  const bind = dataRef.bind;
  if (bind == null || Object.keys(bind).length === 0) return dataRef.$ref;

  const parsed = parseQueryRef(dataRef.$ref);
  const params = { ...parsed.params };
  let changed = false;
  for (const [param, binding] of Object.entries(bind)) {
    const current = state[binding.$state];
    if (current === undefined) continue; // if undefined, keep the initial value (leaving $ref as-is)
    const next = String(current);
    if (next !== params[param]) {
      params[param] = next;
      changed = true;
    }
  }
  if (!changed) return dataRef.$ref; // every parameter still at its initial value = initial variant
  return formatQueryRef({ source: parsed.source, path: parsed.path, params });
}

/**
 * Enumerates, as canonical URIs, every effective ref reachable through the Cartesian product of
 * bind's `values` (including the initial variant = $ref). This corresponds 1:1 with capability
 * issuance at compose time (each variant becomes a read scope). If bind is absent, returns $ref alone
 * (in canonical form).
 *
 * The sole source of truth for authorization is `values` (it does not depend on the control's
 * options), and the effective refs a renderer can issue are limited to the set enumerated here
 * (the no-forgery principle).
 */
/**
 * The upper bound on the number of variants enumerateBindVariants would produce for this dataRef: the
 * product of each bound parameter's `values` length (1 when bind is absent/empty, matching
 * enumerateBindVariants returning a single-element array in that case). This is always >= the actual
 * (deduplicated) count enumerateBindVariants returns, so it is safe to use as a cheap pre-check that
 * rejects an enormous Cartesian product (e.g. 4 bound params x 20 values each = 160,000 combinations)
 * before materializing it, without changing the exact limit enforced after real enumeration.
 */
export function bindVariantUpperBound(dataRef: DataRef): number {
  const bind = dataRef.bind;
  if (bind == null) return 1;
  let total = 1;
  for (const binding of Object.values(bind)) {
    total *= binding.values.length;
  }
  return total;
}

export function enumerateBindVariants(dataRef: DataRef): string[] {
  const parsed = parseQueryRef(dataRef.$ref);
  const bind = dataRef.bind;
  const entries = bind != null ? Object.entries(bind) : [];
  if (entries.length === 0) return [parsed.raw];

  // Cartesian product of each bound parameter's values (the initial value is included in values —
  // guaranteed by BIND_VALUE_INVALID).
  let combos: Record<string, string>[] = [{}];
  for (const [param, binding] of entries) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const value of binding.values) {
        next.push({ ...combo, [param]: value });
      }
    }
    combos = next;
  }

  const variants = combos.map((combo) =>
    formatQueryRef({ source: parsed.source, path: parsed.path, params: { ...parsed.params, ...combo } }),
  );
  // Deduplicate even when duplicate values, or overlap with the initial value, produce the same
  // canonical URI (kept 1:1 with scope issuance).
  return [...new Set(variants)];
}

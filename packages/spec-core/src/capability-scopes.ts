import { collectWriteActions } from "./action-name.js";
import { bindVariantUpperBound, enumerateBindVariants } from "./bind.js";
import type { Scope } from "./ports.js";
import type { UISpec } from "./schema/spec.js";
import { MAX_BIND_VARIANTS } from "./validate.js";

/**
 * Collects the capability scopes implied by a Spec's declarations (SPEC §5 A1; the single source of
 * truth for the issuance rule).
 * - read: every $ref (references that components resolve data from). When `data.bind` (two-way
 *   binding, kohaku >= 0.2 [Draft]) is present, enumerateBindVariants enumerates every effective ref
 *   reachable through the Cartesian product of `values`, and each variant becomes a read scope (the
 *   initial variant = $ref is included in the enumerated set). This lets only the finite set of refs
 *   the client can re-resolve by changing $state (= the set authorized at compose time) through,
 *   preserving the no-forgery principle (unlike exempting the `_` reserved parameter from
 *   authorization, a filter would change what is authorized, so we cover it by enumeration instead).
 * - write: the action names invoked by events with emit==="action.invoke" (collectWriteActions).
 *   Symmetric to read covering "references the UI reads", write covers "writes the UI declared".
 *   Without it a compose-derived capability would only carry read scopes and presentForm submit /
 *   action.button could not fire.
 *
 * MAX_BIND_VARIANTS rejects scope blow-up from the Cartesian product of bind variants (a defense
 * paired with validate's BIND_VARIANT_LIMIT; L0 fixed Specs do not go through validateSpecStructure,
 * so this check at the issuance boundary is the last line of defense).
 *
 * Both host-rest (issueCapabilityForSpec) and host-mcp-apps (issueCapability) consume this so the
 * issuance rule matches across both profiles (no duplicated rule — the same "spec-core is the
 * definition site" principle as resolveWriteActionName). The real authority stays with AuthzPort
 * (a product's issueCapability can deny scopes by principal). This only maps the operations the
 * composed UI declared onto scopes.
 */
export function collectCapabilityScopes(spec: UISpec): Scope[] {
  // Fast pre-check: sum each component's bind-variant upper bound (the product of its bound params'
  // value-set sizes, before any deduplication) and reject immediately if that alone already exceeds
  // the limit. Avoids materializing a Cartesian product that could be enormous (e.g. 4 bound params x
  // 20 values each = 160,000 combinations) only to throw it away; the exact (deduplicated) count is
  // still checked below for the case where the upper bound passes but real enumeration does not.
  const upperBoundTotal = spec.components.reduce(
    (n, c) => n + (c.data != null ? bindVariantUpperBound(c.data) : 0),
    0,
  );
  if (upperBoundTotal > MAX_BIND_VARIANTS) {
    throw new Error(
      `total bind variants ${upperBoundTotal} exceed the limit ${MAX_BIND_VARIANTS} (caps capability issuance growth)`,
    );
  }

  const variantsByComponent = spec.components.map((c) =>
    c.data != null ? enumerateBindVariants(c.data) : [],
  );
  const variantTotal = variantsByComponent.reduce((n, v) => n + v.length, 0);
  if (variantTotal > MAX_BIND_VARIANTS) {
    throw new Error(
      `total bind variants ${variantTotal} exceed the limit ${MAX_BIND_VARIANTS} (caps capability issuance growth)`,
    );
  }
  const refs = [...new Set(variantsByComponent.flat())];
  return [
    ...refs.map((ref) => ({ kind: "read" as const, ref })),
    ...collectWriteActions(spec).map((action) => ({ kind: "write" as const, ref: action })),
  ];
}

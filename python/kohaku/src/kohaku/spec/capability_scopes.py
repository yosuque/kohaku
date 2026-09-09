"""Rule for collecting the capability scopes implied by a Spec's declarations (port of TS capability-scopes.ts — the single source of truth for the issuance rule).

Faithful port of TS `collectCapabilityScopes` (packages/spec-core/src/capability-scopes.ts). Both
host_rest (issue_capability_for_spec) and host_mcp (_issue_capability) consume this so the issuance rule
matches across both profiles (no duplicated rule — the same "the spec layer is the definition site"
principle as resolve_write_action_name).
"""

from __future__ import annotations

from .action_name import collect_write_actions
from .bind import bind_variant_upper_bound, enumerate_bind_variants
from .models import UISpec
from .ports import Scope
from .validate import MAX_BIND_VARIANTS


def collect_capability_scopes(spec: UISpec) -> list[Scope]:
    """Collect the capability scopes implied by a Spec's declarations (SPEC §5 A1; the single source of truth for the issuance rule).

    - read: every $ref (references that components resolve data from). When `data.bind` (two-way binding)
      is present, enumerate every effective ref reachable through the Cartesian product of `values` with
      enumerate_bind_variants and make each variant a read scope (the initial variant = $ref is included in
      the enumerated set). This lets only the finite set of refs the client can re-resolve by changing
      $state (= the set authorized at compose time) through, preserving the no-forgery principle.
    - write: the action names invoked by events with emit=="action.invoke" (collect_write_actions).
      Symmetric to read covering "references the UI reads", write covers "writes the UI declared". Without
      it a compose-derived capability would only carry read scopes and presentForm submit / action.button
      could not fire.

    MAX_BIND_VARIANTS rejects scope blow-up from the Cartesian product of bind variants (a defense paired
    with validate's BIND_VARIANT_LIMIT; L0 fixed Specs do not go through validate_spec_structure, so this
    check at the issuance boundary is the last line of defense). The real authority stays with AuthzPort (a
    product's issue_capability can deny scopes by principal); here we only map the operations the composed
    UI declared onto scopes.

    Read scopes are ordered by concatenating each component's enumerate_bind_variants in spec.components
    order and deduplicating; write scopes follow, in collect_write_actions order (matching TS).
    """
    # Fast pre-check: sum each component's bind-variant upper bound (the product of its bound params'
    # value-set sizes, before any deduplication) and reject immediately if that alone already exceeds the
    # limit. Avoids materializing a Cartesian product that could be enormous (e.g. 4 bound params x 20
    # values each = 160,000 combinations) only to throw it away; the exact (deduplicated) count is still
    # checked below for the case where the upper bound passes but real enumeration does not.
    upper_bound_total = sum(
        bind_variant_upper_bound(c.data) if c.data is not None else 0 for c in spec.components
    )
    if upper_bound_total > MAX_BIND_VARIANTS:
        raise ValueError(
            f"total bind variants {upper_bound_total} exceed the limit {MAX_BIND_VARIANTS}"
            " (caps capability issuance growth)"
        )

    variants_by_component = [
        enumerate_bind_variants(c.data) if c.data is not None else [] for c in spec.components
    ]
    variant_total = sum(len(v) for v in variants_by_component)
    if variant_total > MAX_BIND_VARIANTS:
        raise ValueError(
            f"total bind variants {variant_total} exceed the limit {MAX_BIND_VARIANTS}"
            " (caps capability issuance growth)"
        )
    refs = list(dict.fromkeys(ref for variants in variants_by_component for ref in variants))
    return [Scope(kind="read", ref=ref) for ref in refs] + [
        Scope(kind="write", ref=action) for action in collect_write_actions(spec)
    ]

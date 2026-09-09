"""Resolve two-way binding ($state → $ref parameter binding) (port of TS bind.ts).

data.bind is a declarative sidecar meaning "substitute specific $ref parameters with $state values to form
the effective ref". $ref is the concrete canonical URI of the initial variant, with bound parameters filled
by the initial $state values; in the initial state (state still at its initial values) the effective ref =
$ref itself.
"""

from __future__ import annotations

from .canonical_json import UNDEFINED, _Undefined, js_string
from .models import DataRef, JsonValue
from .query_ref import format_query_ref, parse_query_ref


def resolve_bound_ref(data_ref: DataRef, state: dict[str, JsonValue]) -> str:
    """Return the effective ref with binding resolved against the current $state.

    - If bind is absent / empty, return $ref as-is (preserving the no-binding behavior byte-for-byte).
    - Even with bind, if every substituted parameter value matches the $ref initial value, return $ref
      as-is. This makes "for the initial variant, effective ref === data.$ref" hold.
    - If any parameter changes from its initial value, parse, swap the value, canonicalize, and return.
      This canonical form matches enumerate_bind_variants (capability enumeration) / the host's base-ref
      validation.

    The substitution value is js_string(state[$state key]) (query parameters are strings). If state lacks
    the key, keep the initial value = $ref.
    """
    bind = data_ref.bind
    if bind is None or len(bind) == 0:
        return data_ref.ref

    parsed = parse_query_ref(data_ref.ref)
    params = dict(parsed.params)
    changed = False
    for param, binding in bind.items():
        current: JsonValue | _Undefined = state.get(binding.state, UNDEFINED)
        if isinstance(current, _Undefined):
            continue  # if undefined, keep the initial value ($ref as-is)
        next_value = js_string(current)
        if next_value != params.get(param):
            params[param] = next_value
            changed = True
    if not changed:
        return data_ref.ref  # all parameters at initial values = the initial variant
    return format_query_ref(source=parsed.source, path=parsed.path, params=params)


def bind_variant_upper_bound(data_ref: DataRef) -> int:
    """The upper bound on the number of variants enumerate_bind_variants would produce for this data_ref:
    the product of each bound parameter's `values` length (1 when bind is absent/empty, matching
    enumerate_bind_variants returning a single-element list in that case). Always >= the actual
    (deduplicated) count enumerate_bind_variants returns, so it is safe to use as a cheap pre-check that
    rejects an enormous Cartesian product (e.g. 4 bound params x 20 values each = 160,000 combinations)
    before materializing it, without changing the exact limit enforced after real enumeration.
    """
    bind = data_ref.bind
    if bind is None:
        return 1
    total = 1
    for binding in bind.values():
        total *= len(binding.values)
    return total


def enumerate_bind_variants(data_ref: DataRef) -> list[str]:
    """Enumerate, as canonical URIs, every effective ref reachable through the Cartesian product of bind's
    `values` (including the initial variant = $ref). Corresponds 1:1 with capability issuance at compose
    time.

    The sole source of truth for authorization is `values`, and the effective refs the renderer can issue
    are limited to the set enumerated here (the no-forgery principle).
    """
    parsed = parse_query_ref(data_ref.ref)
    bind = data_ref.bind
    entries = list(bind.items()) if bind is not None else []
    if len(entries) == 0:
        return [parsed.raw]

    # Cartesian product of each bound parameter's values (the initial value is included in values).
    combos: list[dict[str, str]] = [{}]
    for param, binding in entries:
        combos = [{**combo, param: value} for combo in combos for value in binding.values]

    variants = [
        format_query_ref(source=parsed.source, path=parsed.path, params={**parsed.params, **combo})
        for combo in combos
    ]
    # Deduplicate even when duplicate values or overlap with the initial value produce the same canonical URI (1:1 with scope issuance).
    return list(dict.fromkeys(variants))

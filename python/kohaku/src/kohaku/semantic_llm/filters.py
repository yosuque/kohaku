"""Vetting of the filters a SemanticPort offers against the Intent's params schema (port of TS filters.ts).

`IntentDef.filters` enumerates every facet's options independently, but the composer signs the whole cartesian
product of the injected `data.bind` values into the capability, and the read path (`/binding/resolve`) never
validates a ref against the Intent's params: a constraint that forbids a combination (or a facet option the
schema does not accept) would otherwise be reachable through a filter.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from kohaku.intents import IntentDef
from kohaku.spec import FilterDescriptor, Intent, JsonObject, QueryHandle, parse_query_ref

DEFAULT_MAX_FILTER_VARIANTS = 64
"""The default budget of the filter product check: the number of option combinations `vet_filters` will validate
against the Intent's params. It is the composer's default `l1FiltersMaxVariants` (64) -- a capability enumerates
one read scope per injected variant, so the composer abandons an injection past that cap anyway."""

ParamsCheck = Callable[[JsonObject], JsonObject | None]
"""The validator the Intent is actually enforced by: the normalized params (defaults filled in), or None when
they are rejected."""


def params_check_for(catalog: Any, def_: IntentDef) -> ParamsCheck:
    """The checker for `def_` through `catalog`: its `validate_params` (strict, the one NL / GUI normalization
    and `validate_intent` enforce), else its `normalize_params`, else the bare schema. A product catalog may add
    constraints on top of the schema, and those are what `/compose` actually enforces. Duck-typed, like
    `LlmSemanticPort.validate_intent` (a Protocol cannot express the optional `validate_params`)."""
    validate_params = getattr(catalog, "validate_params", None)
    if validate_params is not None:

        def via_validate(params: JsonObject) -> JsonObject | None:
            result = validate_params(def_.name, params)
            return result.params if result.ok else None

        return via_validate
    normalize_params = getattr(catalog, "normalize_params", None)
    if normalize_params is not None:
        return lambda params: normalize_params(def_.name, params)

    def via_schema(params: JsonObject) -> JsonObject | None:
        parsed = def_.params.safe_parse(params)
        return parsed.data if parsed.success else None

    return via_schema


def _current_value(filter_: FilterDescriptor, handles: list[QueryHandle]) -> str | None:
    """The value every governed ref of the Intent currently carries for the filter's query param, or None when
    the composer would not inject the filter (no ref on one of its `paths` carries the param, or the carriers
    disagree) -- inject_filters' own rule, read off the refs the Intent resolves to."""
    carried: set[str] = set()
    for handle in handles:
        try:
            ref = parse_query_ref(handle.uri)
        except Exception:  # noqa: BLE001 - an unparsable ref governs nothing
            continue
        if ref.path in filter_.paths and filter_.queryParam in ref.params:
            carried.add(ref.params[filter_.queryParam])
    return next(iter(carried)) if len(carried) == 1 else None


def vet_filters(
    def_: IntentDef,
    intent: Intent,
    filters: list[FilterDescriptor],
    max_variants: int,
    check: ParamsCheck | None = None,
) -> list[FilterDescriptor]:
    """Makes the Intent's own params validation the authority over the filters offered.

    0. The Intent's own params are validated first (`check`, default the bare schema); rejected params offer
       no filters.
    1. A filter the composer would NOT inject is dropped: no ref of the Intent carries its query param on its
       `paths`, the carriers disagree, or the carried value is not among its options (inject_filters' skip
       rule). Such a param stays at its un-vetted value in the signed product, so the product below must not
       range over it; the vetted product is exactly the signed one.
    2. Each remaining option is validated on its own: `check({**params, param: option})`; a rejected option is
       dropped.
    3. A filter left with fewer than 2 options is dropped (nothing to choose).
    4. The cartesian product of what remains (bounded by `max_variants`) is validated the same way. If any
       combination fails, or the product exceeds the budget (not provable), NO filter is returned for the
       Intent -- fail-safe, never worse than not injecting.

    The budget counts the product over ALL remaining filters, a superset of any one component's product that
    the composer counts (its `totalVariants` is a per-component product summed over components): it is
    deliberately conservative.
    """
    validate = check if check is not None else params_check_for(None, def_)
    base = validate(dict(intent.params))
    if base is None:
        return []
    try:
        handles = def_.to_queries(dict(intent.params))
    except Exception:  # noqa: BLE001 - mirrors TS: unresolvable refs offer no filters
        return []

    def accepts(overrides: dict[str, str]) -> bool:
        return validate({**base, **overrides}) is not None

    governed = [
        f
        for f in filters
        if (value := _current_value(f, handles)) is not None
        and any(o.value == value for o in f.options)
    ]
    vetted = [
        replace(f, options=[o for o in f.options if accepts({f.param: o.value})]) for f in governed
    ]
    vetted = [f for f in vetted if len(f.options) >= 2]
    if len(vetted) == 0:
        return vetted

    total = 1
    for f in vetted:
        total *= len(f.options)
    if total > max_variants:
        return []

    for combo in itertools.product(*(f.options for f in vetted)):
        if not accepts({f.param: o.value for f, o in zip(vetted, combo, strict=True)}):
            return []
    return vetted

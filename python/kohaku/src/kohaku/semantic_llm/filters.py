"""Vetting of the filters a SemanticPort offers against the Intent's params schema (port of TS filters.ts).

`IntentDef.filters` enumerates every facet's options independently, but the composer signs the whole cartesian
product of the injected `data.bind` values into the capability, and the read path (`/binding/resolve`) never
validates a ref against the Intent's params: a constraint that forbids a combination (or a facet option the
schema does not accept) would otherwise be reachable through a filter.
"""

from __future__ import annotations

import itertools
from dataclasses import replace

from kohaku.intents import IntentDef
from kohaku.spec import FilterDescriptor, Intent

DEFAULT_MAX_FILTER_VARIANTS = 64
"""The default budget of the filter product check: the number of option combinations `vet_filters` will validate
against the Intent's params. It is the composer's default `l1FiltersMaxVariants` (64) -- a capability enumerates
one read scope per injected variant, so the composer abandons an injection past that cap anyway."""


def vet_filters(
    def_: IntentDef, intent: Intent, filters: list[FilterDescriptor], max_variants: int
) -> list[FilterDescriptor]:
    """Makes the Intent's own params schema the authority over the filters offered.

    1. Each option is validated on its own: `params.safe_parse({**intent.params, param: option})`; an option the
       schema rejects is dropped.
    2. A filter left with fewer than 2 options is dropped (nothing to choose).
    3. The cartesian product of the remaining filters (bounded by `max_variants`) is validated the same way. If
       any combination fails, or the product exceeds the budget (not provable), NO filter is returned for the
       Intent -- fail-safe, never worse than not injecting.
    """
    base = dict(intent.params)

    def accepts(overrides: dict[str, str]) -> bool:
        return def_.params.safe_parse({**base, **overrides}).success

    vetted = [
        replace(f, options=[o for o in f.options if accepts({f.param: o.value})]) for f in filters
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

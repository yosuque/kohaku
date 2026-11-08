"""Deterministic L1 filter injection (port of TS post/inject-filters.ts; `ComposePolicy.l1Filters`).

The model never sees or decides this: for each `FilterDescriptor` whose `queryParam` appears in a data
component's `$ref` it adds
  - a `control.select` (id `filter-<param>`, options from the descriptor, value = the ref's current value),
    placed first among the root's children;
  - `state[<param>]` = the current value (taken from the ref, so spec-core's initial-ref = initial-state
    check holds), and a `filter-<param>.change` -> `state.set` event;
  - `data.bind[<queryParam>] = { $state: <param>, values }` on every data component carrying that param.

A descriptor is skipped (others still apply) when: no data component carries its `queryParam`; the carriers
disagree on its current value or it is not among `options` (e.g. cleared); or its id / state key / event
would collide with the Spec's own or violate the id grammar. The whole injection is abandoned (input
returned unchanged) when the total bind variants would exceed MAX_BIND_VARIANTS, the root cannot host
controls, or the result fails `validate_spec_structure` (fail-safe: never worse than not injecting).

Pure, idempotent-by-collision (a second pass finds the ids taken and injects nothing), input never mutated.
Runs after ID normalization, so the injected ids are not renamed by it.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from kohaku.spec import (
    MAX_BIND_VARIANTS,
    ROOT_COMPONENT_ID,
    BindParam,
    ComponentNode,
    EventBinding,
    FilterDescriptor,
    UISpec,
    parse_query_ref,
    validate_spec_structure,
)

# The root types that can host injected controls as children (both declare `children: "optional"`).
_HOST_ROOT_TYPES = frozenset({"layout.stack", "layout.grid"})

# Mirrors spec-core's ComponentIdSchema / StateKeySchema (a descriptor outside them is skipped, never rewritten).
_COMPONENT_ID = re.compile(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}")
_STATE_KEY = re.compile(r"[a-zA-Z][a-zA-Z0-9_]{0,63}")


@dataclass(frozen=True)
class InjectFiltersResult:
    spec: UISpec
    injected: list[str]
    """The `FilterDescriptor.param` of every filter that was injected, in descriptor order."""
    skipped: Literal["variant-limit", "invalid"] | None = None
    """Set when filters were applicable but the whole injection was abandoned (the input Spec is returned
    unchanged): `variant-limit` when the bind variants would exceed MAX_BIND_VARIANTS, `invalid` when the
    root cannot host controls or the result failed structural validation."""


@dataclass(frozen=True)
class _Plan:
    descriptor: FilterDescriptor
    value: str
    """The current value: the shared `queryParam` value of every data component carrying it."""
    values: list[str]


def _ref_params(ref: str) -> dict[str, str] | None:
    """The query params of a `$ref`, or None when it does not parse (the component is then not a target)."""
    try:
        return dict(parse_query_ref(ref).params)
    except Exception:  # noqa: BLE001 - mirrors TS's try/catch: any parse failure means "not a target"
        return None


def inject_filters(spec: UISpec, descriptors: Sequence[FilterDescriptor]) -> InjectFiltersResult:
    def unchanged(
        skipped: Literal["variant-limit", "invalid"] | None = None,
    ) -> InjectFiltersResult:
        return InjectFiltersResult(spec=spec, injected=[], skipped=skipped)

    if len(descriptors) == 0:
        return unchanged()

    taken = {c.id for c in spec.components}
    state_keys = set((spec.state or {}).keys())
    event_targets = {e.on for e in spec.events}

    plans: list[_Plan] = []
    for descriptor in descriptors:
        param = descriptor.param
        query_param = descriptor.queryParam
        component_id = f"filter-{param}"
        if _COMPONENT_ID.fullmatch(component_id) is None or _STATE_KEY.fullmatch(param) is None:
            continue
        # `_`-prefixed query params are the reserved (authorization-exempt) namespace; spec-core rejects
        # binding them.
        if query_param == "" or query_param.startswith("_"):
            continue
        if (
            component_id in taken
            or param in state_keys
            or f"{component_id}.change" in event_targets
        ):
            continue
        if any(p.descriptor.param == param for p in plans):
            continue

        carried: list[str] = []
        blocked = False
        for c in spec.components:
            if c.data is None:
                continue
            params = _ref_params(c.data.ref)
            if params is None or query_param not in params:
                continue
            # A component already bound on this query param is left to its own declaration: skip the filter.
            if c.data.bind is not None and query_param in c.data.bind:
                blocked = True
            if params[query_param] not in carried:
                carried.append(params[query_param])
        if blocked or len(carried) != 1:
            continue
        value = carried[0]
        values = list(dict.fromkeys(o.value for o in descriptor.options))
        if value not in values:
            continue
        plans.append(_Plan(descriptor=descriptor, value=value, values=values))
    if len(plans) == 0:
        return unchanged()

    root = next((c for c in spec.components if c.id == ROOT_COMPONENT_ID), None)
    if root is None or root.type not in _HOST_ROOT_TYPES or root.children is None:
        return unchanged("invalid")

    # Rebuild the data components with the new binds, counting variants like spec-core's BIND_VARIANT_LIMIT
    # (per component: the product of each bound param's distinct values; summed over the Spec).
    bind_by_query_param = {
        p.descriptor.queryParam: BindParam.model_validate(
            {"$state": p.descriptor.param, "values": p.values}
        )
        for p in plans
    }
    total_variants = 0
    rebuilt: list[ComponentNode] = []
    for c in spec.components:
        if c.data is None:
            rebuilt.append(c)
            continue
        params = _ref_params(c.data.ref)
        added = (
            {}
            if params is None
            else {qp: b for qp, b in bind_by_query_param.items() if qp in params}
        )
        bind = {**(c.data.bind or {}), **added}
        variants = 1
        for b in bind.values():
            variants *= len(set(b.values))
        total_variants += variants
        if len(added) == 0:
            rebuilt.append(c)
        else:
            rebuilt.append(c.model_copy(update={"data": c.data.model_copy(update={"bind": bind})}))
    if total_variants > MAX_BIND_VARIANTS:
        return unchanged("variant-limit")

    controls = [
        ComponentNode.model_validate(
            {
                "id": f"filter-{p.descriptor.param}",
                "type": "control.select",
                "props": {
                    "label": p.descriptor.label,
                    "value": p.value,
                    "options": [{"value": o.value, "label": o.label} for o in p.descriptor.options],
                },
            }
        )
        for p in plans
    ]
    root_index = next(i for i, c in enumerate(rebuilt) if c.id == ROOT_COMPONENT_ID)
    rebuilt[root_index] = root.model_copy(
        update={"children": [*(c.id for c in controls), *root.children]}
    )
    # DFS-consistent position: root first, then the controls (first among its children), then the rest.
    ordered = [*rebuilt[: root_index + 1], *controls, *rebuilt[root_index + 1 :]]

    events = [
        *spec.events,
        *(
            EventBinding.model_validate(
                {
                    "on": f"filter-{p.descriptor.param}.change",
                    "emit": "state.set",
                    "payload": {"key": p.descriptor.param, "value": "$value"},
                }
            )
            for p in plans
        ),
    ]
    state = {**(spec.state or {}), **{p.descriptor.param: p.value for p in plans}}

    candidate = spec.model_copy(update={"components": ordered, "events": events, "state": state})
    if any(i.severity == "error" for i in validate_spec_structure(candidate)):
        return unchanged("invalid")
    return InjectFiltersResult(
        spec=candidate, injected=[p.descriptor.param for p in plans], skipped=None
    )

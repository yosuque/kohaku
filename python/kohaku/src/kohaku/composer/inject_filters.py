"""Deterministic L1 filter injection (port of TS post/inject-filters.ts; `ComposePolicy.l1Filters`).

The model never sees or decides this: for each `FilterDescriptor` whose `queryParam` appears in the `$ref` of a
data component reading one of the descriptor's `paths` it adds
  - a `control.select` (id `filter-<param>`, options from the descriptor, value = the ref's current value),
    placed first among the root's children;
  - `state[<param>]` = the current value (taken from the ref, so spec-core's initial-ref = initial-state
    check holds), and a `filter-<param>.change` -> `state.set` event;
  - `data.bind[<queryParam>] = { $state: <param>, values }` on every data component the filter governs (path
    in `paths` and the query parameter present); a component on another path is never touched.

A descriptor is skipped (others still apply) when: no data component carries its `queryParam`; the carriers
disagree on its current value or it is not among `options` (e.g. a cleared "all" value -- a selected value
cannot be cleared back to "all" either: `bind.values` has no empty value, same as the L0 cross-filter); its id /
state key / event would collide with the Spec's own or violate the id grammar; or an earlier descriptor
already governs the same `queryParam` on an overlapping path. The whole injection is abandoned (input
returned unchanged) when the total bind variants would exceed `max_variants`, the root cannot host controls,
or the result fails `validate_spec_structure` (fail-safe: never worse than not injecting).

Pure, idempotent-by-collision (a second pass finds the ids taken and injects nothing), input never mutated.
Runs after ID normalization, so the injected ids are not renamed by it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic import TypeAdapter, ValidationError

from kohaku.spec import (
    MAX_BIND_VARIANTS,
    ROOT_COMPONENT_ID,
    BindParam,
    ComponentNode,
    EventBinding,
    FilterDescriptor,
    FilterOption,
    UISpec,
    parse_query_ref,
    validate_spec_structure,
)
from kohaku.spec.models import ComponentId, StateKey

# The root types that can host injected controls as children (both declare `children: "optional"`).
_HOST_ROOT_TYPES = frozenset({"layout.stack", "layout.grid"})

DEFAULT_L1_FILTERS_MAX_VARIANTS = 64
"""The default cap on the bind variants one injection may create (`ComposePolicy.l1FiltersMaxVariants`). A
capability enumerates one read scope per variant: 256 scopes are about 35 KB, past Node's 16 KiB header limit
(so a TS host's `/binding/resolve` would answer 431), while 64 stay near 9 KB. Always further bounded by
MAX_BIND_VARIANTS."""

# spec-core's own id / state-key types (a descriptor outside them is skipped, never rewritten).
_COMPONENT_ID = TypeAdapter(ComponentId)
_STATE_KEY = TypeAdapter(StateKey)


def _valid(adapter: TypeAdapter[str], value: str) -> bool:
    try:
        adapter.validate_python(value)
    except ValidationError:
        return False
    return True


@dataclass(frozen=True)
class InjectFiltersResult:
    spec: UISpec
    injected: list[str]
    """The `FilterDescriptor.param` of every filter that was injected, in descriptor order."""
    skipped: Literal["variant-limit", "invalid"] | None = None
    """Set when filters were applicable but the whole injection was abandoned (the input Spec is returned
    unchanged): `variant-limit` when the bind variants would exceed `max_variants` (itself capped by
    MAX_BIND_VARIANTS), `invalid` when the root cannot host controls or the result failed structural validation."""


@dataclass(frozen=True)
class _Plan:
    descriptor: FilterDescriptor
    value: str
    """The current value: the shared `queryParam` value of every data component this filter governs."""
    options: list[FilterOption]
    """The descriptor's options, de-duplicated by value (first wins): the control's options and the bind values."""


def _parse_ref(ref: str) -> tuple[str, dict[str, str]] | None:
    """A `$ref`'s path and query params, or None when it does not parse (the component is then not a target)."""
    try:
        parsed = parse_query_ref(ref)
    except Exception:  # noqa: BLE001 - mirrors TS's try/catch: any parse failure means "not a target"
        return None
    return parsed.path, dict(parsed.params)


def inject_filters(
    spec: UISpec,
    descriptors: Sequence[FilterDescriptor],
    *,
    max_variants: int | None = None,
) -> InjectFiltersResult:
    cap = min(
        max_variants if max_variants is not None else DEFAULT_L1_FILTERS_MAX_VARIANTS,
        MAX_BIND_VARIANTS,
    )

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
        if not _valid(_COMPONENT_ID, component_id) or not _valid(_STATE_KEY, param):
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
        # One query parameter, one filter per path: a later descriptor on an overlapping path would otherwise
        # overwrite the earlier bind.
        if any(
            p.descriptor.queryParam == query_param
            and any(x in descriptor.paths for x in p.descriptor.paths)
            for p in plans
        ):
            continue

        carried: list[str] = []
        blocked = False
        for c in spec.components:
            if c.data is None:
                continue
            ref = _parse_ref(c.data.ref)
            if ref is None:
                continue
            path, params = ref
            if path not in descriptor.paths or query_param not in params:
                continue
            # A component already bound on this query param is left to its own declaration: skip the filter.
            if c.data.bind is not None and query_param in c.data.bind:
                blocked = True
            if params[query_param] not in carried:
                carried.append(params[query_param])
        if blocked or len(carried) != 1:
            continue
        value = carried[0]
        options: list[FilterOption] = []
        for o in descriptor.options:
            if not any(x.value == o.value for x in options):
                options.append(o)
        if not any(o.value == value for o in options):
            continue
        plans.append(_Plan(descriptor=descriptor, value=value, options=options))
    if len(plans) == 0:
        return unchanged()

    root = next((c for c in spec.components if c.id == ROOT_COMPONENT_ID), None)
    if root is None or root.type not in _HOST_ROOT_TYPES or root.children is None:
        return unchanged("invalid")

    # Rebuild the data components with the new binds, counting variants like spec-core's BIND_VARIANT_LIMIT
    # (per component: the product of each bound param's distinct values; summed over the Spec).
    total_variants = 0
    rebuilt: list[ComponentNode] = []
    for c in spec.components:
        if c.data is None:
            rebuilt.append(c)
            continue
        ref = _parse_ref(c.data.ref)
        added: dict[str, BindParam] = {}
        if ref is not None:
            path, params = ref
            for p in plans:
                if path in p.descriptor.paths and p.descriptor.queryParam in params:
                    added[p.descriptor.queryParam] = BindParam.model_validate(
                        {"$state": p.descriptor.param, "values": [o.value for o in p.options]}
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
    if total_variants > cap:
        return unchanged("variant-limit")

    controls = [
        ComponentNode.model_validate(
            {
                "id": f"filter-{p.descriptor.param}",
                "type": "control.select",
                "props": {
                    "label": p.descriptor.label,
                    "value": p.value,
                    "options": [{"value": o.value, "label": o.label} for o in p.options],
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

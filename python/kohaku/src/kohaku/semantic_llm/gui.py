"""Deterministic normalization of GUI operations (port of packages/semantic-llm/src/gui.ts). Never goes
through the LLM.

1. `view.select` / `facet.change`: the target Intent comes from params.intent (or the current Intent); facets
   are merged over the current params only when the Intent is unchanged.
2. A component event ("table1.rowClick", ...) with a current Intent: delegated to the definition's drilldown,
   or, without one, the payload is merged into the current params.

Failures raise ValueError (TS: Error) with the same messages as TS.
"""

from __future__ import annotations

from kohaku.spec import GuiAction, IntentInput, JsonObject

from .catalog import IntentCatalogLike


def normalize_gui_action(input: GuiAction, catalog: IntentCatalogLike) -> IntentInput:
    if input.action in ("view.select", "facet.change"):
        requested = input.params.get("intent")
        if requested is None and input.current is not None:
            requested = input.current.canonical
        if requested is None:
            raise ValueError(f"{input.action} requires params.intent or a current Intent")
        if not isinstance(requested, str) or catalog.get(requested) is None:
            raise ValueError(f"unknown intent: {requested}")
        facets = {k: v for k, v in input.params.items() if k != "intent"}
        base: JsonObject = (
            dict(input.current.params)
            if input.current is not None and input.current.canonical == requested
            else {}
        )
        params = catalog.normalize_params(requested, {**base, **facets})
        if params is None:
            raise ValueError(f"invalid params for {requested}")
        return IntentInput(canonical=requested, params=params)

    if "." in input.action and input.current is not None:
        current = input.current
        def_ = catalog.get(current.canonical)
        if def_ is not None and def_.drilldown is not None:
            nxt = def_.drilldown(current.params, input.params)
            canonical = nxt.canonical if nxt.canonical is not None else current.canonical
            params = catalog.normalize_params(canonical, nxt.params)
            if params is None:
                raise ValueError(f"drilldown produced invalid params for {canonical}")
            return IntentInput(canonical=canonical, params=params)
        merged = catalog.normalize_params(current.canonical, {**current.params, **input.params})
        if merged is None:
            raise ValueError("event payload produced invalid params")
        return IntentInput(canonical=current.canonical, params=merged)

    raise ValueError(f"unsupported gui action: {input.action}")

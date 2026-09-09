"""Deterministic post-processor (port of TS post/rules.ts + post/index.ts).

After the 4 standard rules (normalize_ids → chart_kind → sort_order → canonical_props), the
product-extension rules are applied in order. All rules are pure and idempotent. Layout rules such as
chart kind and sort order are applied on the code side rather than left to the LLM.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass

from kohaku.registry import ResolvedCatalog
from kohaku.spec import (
    ROOT_COMPONENT_ID,
    SANDBOX_HTML_TYPE,
    ComponentNode,
    DataShape,
    EventBinding,
    UISpec,
    normalize_json_value,
    order_components,
)


@dataclass(frozen=True)
class PostProcessContext:
    catalog: ResolvedCatalog
    shapesByRef: dict[str, DataShape]
    """query:// URI → column metadata (empty when SemanticPort.describe_shape is absent)"""


type PostRule = Callable[[UISpec, PostProcessContext], UISpec]

# type → deterministic ID prefix
_ID_PREFIX: dict[str, str] = {
    "layout.stack": "stack",
    "layout.grid": "grid",
    "layout.tabs": "tabs",
    "layout.tab": "tab",
    "text.heading": "title",
    "presentChart": "chart",
    "presentSpreadsheet": "table",
    "presentMarkdown": "md",
    "presentForm": "form",
    "presentMetric": "metric",
    "presentList": "list",
    "action.button": "btn",
    "ui.loading": "loading",
    SANDBOX_HTML_TYPE: "sandbox",
}

_NON_ALNUM_RE = re.compile(r"[^a-zA-Z0-9]+")


def _id_prefix(type_: str) -> str:
    return _ID_PREFIX.get(type_) or _NON_ALNUM_RE.sub("_", type_).lower()


def normalize_ids(spec: UISpec, ctx: PostProcessContext) -> UISpec:
    """ID determinization: root stays as-is; others become "type-prefix + sequence number" in DFS order.

    children / events references are also rewritten consistently via the rename table (this rule must be applied first).
    """
    ordered = order_components(spec.components)
    rename: dict[str, str] = {}
    counts: dict[str, int] = {}
    for node in ordered:
        if node.id == ROOT_COMPONENT_ID:
            rename[node.id] = ROOT_COMPONENT_ID
            continue
        prefix = _id_prefix(node.type)
        counts[prefix] = counts.get(prefix, 0) + 1
        rename[node.id] = f"{prefix}{counts[prefix]}"

    components = [
        node.model_copy(
            update={
                "id": rename[node.id],
                **(
                    {"children": [rename.get(c, c) for c in node.children]}
                    if node.children is not None
                    else {}
                ),
            }
        )
        for node in ordered
    ]

    events: list[EventBinding] = []
    for e in spec.events:
        dot = e.on.find(".")
        if dot < 0:
            events.append(e)  # leave values that are not in "componentId.eventName" form untouched
            continue
        target = e.on[:dot]
        renamed = rename.get(target)
        events.append(
            e.model_copy(update={"on": f"{renamed}{e.on[dot:]}"}) if renamed is not None else e
        )

    return spec.model_copy(update={"components": components, "events": events})


def chart_kind(spec: UISpec, ctx: PostProcessContext) -> UISpec:
    """Chart-kind rule: a time-series x → line; a proportion chart (pie) is allowed only with 6 or fewer categories.

    Overrides the LLM's choice with a deterministic rule (skipped when there is no DataShape).
    """
    components: list[ComponentNode] = []
    for node in spec.components:
        if node.type != "presentChart" or node.data is None:
            components.append(node)
            continue
        shape = ctx.shapesByRef.get(node.data.ref)
        if shape is None:
            components.append(node)
            continue
        props = dict(node.props)
        x_col = next((c for c in shape.columns if c.name == props.get("x")), None)
        if x_col is not None and (x_col.role == "time" or x_col.type == "date"):
            props["kind"] = "line"
        elif props.get("kind") == "pie" and (
            shape.rowCountHint if shape.rowCountHint is not None else math.inf
        ) > 6:
            # An unknown row count is treated as Infinity, erring on the safe side and turning pie into bar.
            props["kind"] = "bar"
        components.append(node.model_copy(update={"props": props}))
    return spec.model_copy(update={"components": components})


def sort_order(spec: UISpec, ctx: PostProcessContext) -> UISpec:
    """Deterministic order: put components in canonical DFS order starting from root.

    Fills presentSpreadsheet with a default sort (descending by the first measure column).
    """
    components: list[ComponentNode] = []
    for node in order_components(spec.components):
        if node.type != "presentSpreadsheet" or node.data is None:
            components.append(node)
            continue
        if node.props.get("sortBy") is not None:
            components.append(node)
            continue
        shape = ctx.shapesByRef.get(node.data.ref)
        measure = (
            next((c for c in shape.columns if c.role == "measure"), None)
            if shape is not None
            else None
        )
        if measure is None:
            components.append(node)
            continue
        components.append(
            node.model_copy(
                update={"props": {**node.props, "sortBy": {"field": measure.name, "dir": "desc"}}}
            )
        )
    return spec.model_copy(update={"components": components})


def canonical_props(spec: UISpec, ctx: PostProcessContext) -> UISpec:
    """props normalization: catalog default filling (using validate's normalized) + key-order normalization.

    Guarantees byte-level determinism.
    """
    result = ctx.catalog.validate(
        [c.to_wire() for c in spec.components], [e.to_wire() for e in spec.events]
    )
    components = [
        ComponentNode.model_validate(normalize_json_value(node)) for node in result.normalized
    ]
    events = [
        EventBinding.model_validate(normalize_json_value(e.to_wire())) for e in spec.events
    ]
    return spec.model_copy(update={"components": components, "events": events})


STANDARD_RULES: list[PostRule] = [normalize_ids, chart_kind, sort_order, canonical_props]


def post_process(
    spec: UISpec, ctx: PostProcessContext, extra_rules: list[PostRule] | None = None
) -> UISpec:
    result = spec
    for rule in [*STANDARD_RULES, *(extra_rules or [])]:
        result = rule(result, ctx)
    return result

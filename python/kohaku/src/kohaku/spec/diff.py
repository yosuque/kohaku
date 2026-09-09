"""Compute UI Spec diffs and apply patches (port of TS diff.ts)."""

from __future__ import annotations

from typing import Any

from .canonical_json import canonical_stringify
from .errors import SpecError
from .models import ComponentNode, SpecPatch, UISpec
from .validate import ROOT_COMPONENT_ID, has_errors, validate_spec_structure


def order_components(components: list[ComponentNode]) -> list[ComponentNode]:
    """Order components in root-first DFS order (unreachable components sorted by id at the end).

    The canonical order of a Spec. Both composer's deterministic post-processing and apply_patch use it.
    """
    by_id = {c.id: c for c in components}
    ordered: list[ComponentNode] = []
    visited: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visited:
            return
        node = by_id.get(node_id)
        if node is None:
            return
        visited.add(node_id)
        ordered.append(node)
        for child in node.children or []:
            visit(child)

    visit(ROOT_COMPONENT_ID)

    orphans = sorted((c for c in components if c.id not in visited), key=lambda c: c.id)
    return [*ordered, *orphans]


def _same_json(a: object, b: object) -> bool:
    """Drop models / None (equivalent to undefined) to wire form and take canonical equality."""
    return canonical_stringify(_to_plain(a)) == canonical_stringify(_to_plain(b))


def _to_plain(value: object) -> object:
    if value is None:
        return None
    to_wire = getattr(value, "to_wire", None)
    if callable(to_wire):
        return to_wire()
    if isinstance(value, list):
        return [_to_plain(v) for v in value]
    return value


def diff_spec(prev: UISpec, next_spec: UISpec) -> SpecPatch:
    """Compute the prev → next diff as a SpecPatch."""
    kwargs: dict[str, Any] = {"baseIntentHash": prev.intent.hash}

    if prev.kohaku != next_spec.kohaku:
        kwargs["kohaku"] = next_spec.kohaku
    if not _same_json(prev.intent, next_spec.intent):
        kwargs["intent"] = next_spec.intent

    prev_by_id = {c.id: c for c in prev.components}
    next_ids = {c.id for c in next_spec.components}

    upsert = [
        c
        for c in next_spec.components
        if c.id not in prev_by_id or not _same_json(prev_by_id[c.id], c)
    ]
    if upsert:
        kwargs["upsert"] = upsert

    remove = [c.id for c in prev.components if c.id not in next_ids]
    if remove:
        kwargs["remove"] = remove

    if not _same_json(prev.events, next_spec.events):
        kwargs["events"] = next_spec.events
    if prev.dataVersion != next_spec.dataVersion:
        kwargs["dataVersion"] = next_spec.dataVersion
    # Full replacement. If next no longer has refVersions (present only in prev), instruct removal with null.
    if not _same_json(prev.refVersions, next_spec.refVersions):
        kwargs["refVersions"] = next_spec.refVersions
    # state is a full replacement of the same kind (null = removal).
    if not _same_json(prev.state, next_spec.state):
        kwargs["state"] = next_spec.state
    if not _same_json(prev.provenance, next_spec.provenance):
        kwargs["provenance"] = next_spec.provenance

    return SpecPatch(**kwargs)


def apply_patch(prev: UISpec, patch: SpecPatch) -> UISpec:
    """Apply a patch. The resulting components are put in canonical order (order_components) and validated structurally.

    If prev is in canonical order, apply_patch(prev, diff_spec(prev, next)) equals next (in canonical order).
    """
    if patch.baseIntentHash != prev.intent.hash:
        raise SpecError(
            "PATCH_BASE_MISMATCH",
            f"patch targets intent {patch.baseIntentHash} but spec has {prev.intent.hash}",
        )

    by_id = {c.id: c for c in prev.components}
    for node_id in patch.remove or []:
        by_id.pop(node_id, None)
    for c in patch.upsert or []:
        by_id[c.id] = c

    kwargs: dict[str, Any] = {
        "kohaku": patch.kohaku if patch.kohaku is not None else prev.kohaku,
        "intent": patch.intent if patch.intent is not None else prev.intent,
        "dataVersion": patch.dataVersion if patch.dataVersion is not None else prev.dataVersion,
        "components": order_components(list(by_id.values())),
        "events": patch.events if patch.events is not None else prev.events,
        "provenance": patch.provenance if patch.provenance is not None else prev.provenance,
    }
    # Tri-state: key absent = no change (keep prev) / null = removal / dict = full replacement
    if patch.is_field_set("refVersions"):
        if patch.refVersions is not None:
            kwargs["refVersions"] = patch.refVersions
    elif prev.refVersions is not None:
        kwargs["refVersions"] = prev.refVersions
    if patch.is_field_set("state"):
        if patch.state is not None:
            kwargs["state"] = patch.state
    elif prev.state is not None:
        kwargs["state"] = prev.state

    next_spec = UISpec(**kwargs)

    issues = validate_spec_structure(next_spec)
    if has_errors(issues):
        raise SpecError(
            "PATCH_APPLY_FAILED",
            "patched spec is structurally invalid: "
            + ", ".join(i.code for i in issues if i.severity == "error"),
            issues,
        )
    return next_spec

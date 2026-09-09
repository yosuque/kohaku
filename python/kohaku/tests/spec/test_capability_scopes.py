"""Tests for collect_capability_scopes (the capability-scope collection rule).

Port of capability-scopes.ts. Because the REST surface (issue_capability_for_spec) and the MCP surface
(_issue_capability) consume the same function, this pins the content and order of the issued scopes (read =
every $ref + the Cartesian product of bind variants / write = declared actions). It also regresses that it
matches the pre-refactor inline rule exactly.
"""

from __future__ import annotations

from typing import Any
from unittest import mock

import pytest

from kohaku.spec import (
    IntentInput,
    Scope,
    UISpec,
    collect_capability_scopes,
    finalize_intent,
)


def _spec(
    components: list[dict[str, Any]],
    events: list[dict[str, Any]],
    *,
    kohaku: str = "0.1",
    state: dict[str, Any] | None = None,
) -> UISpec:
    """Build a minimal valid UISpec for tests (the intent hash is filled correctly by finalize_intent)."""
    intent = finalize_intent(IntentInput(canonical="sales.trend", params={}))
    data: dict[str, Any] = {
        "kohaku": kohaku,
        "intent": intent.to_wire(),
        "dataVersion": "x",
        "components": components,
        "events": events,
        "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
    }
    if state is not None:
        data["state"] = state
    return UISpec.model_validate(data)


def test_no_data_no_events_returns_empty() -> None:
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["h"]},
            {"id": "h", "type": "text.heading", "props": {"level": 2, "text": "Heading"}},
        ],
        [],
    )
    assert collect_capability_scopes(spec) == []


def test_plain_ref_yields_canonical_read_scope() -> None:
    """A $ref without bind becomes one canonicalized read scope (same as enumerate_bind_variants)."""
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["t"]},
            {
                "id": "t",
                "type": "presentSpreadsheet",
                "props": {},
                "data": {"$ref": "query://s/p?b=2&a=1"},
            },
        ],
        [],
    )
    assert collect_capability_scopes(spec) == [Scope(kind="read", ref="query://s/p?a=1&b=2")]


def test_bind_variants_read_scopes_preserve_value_order() -> None:
    """Each element of bind's values Cartesian product becomes a read scope; order follows values (us/eu/jp)."""
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c"]},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": "revenue"},
                "data": {
                    "$ref": "query://sales/trend?granularity=month&metric=revenue&region=us",
                    "bind": {"region": {"$state": "region", "values": ["us", "eu", "jp"]}},
                },
            },
        ],
        [],
        kohaku="0.2",
        state={"region": "us"},
    )
    assert collect_capability_scopes(spec) == [
        Scope(kind="read", ref="query://sales/trend?granularity=month&metric=revenue&region=us"),
        Scope(kind="read", ref="query://sales/trend?granularity=month&metric=revenue&region=eu"),
        Scope(kind="read", ref="query://sales/trend?granularity=month&metric=revenue&region=jp"),
    ]


def test_write_scope_comes_after_reads() -> None:
    """Ordered read (references the UI reads) → write (writes the UI declared)."""
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c", "f"]},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": "revenue"},
                "data": {"$ref": "query://s/p?a=1"},
            },
            {"id": "f", "type": "presentForm", "props": {"action": "annotate"}},
        ],
        [{"on": "f.submit", "emit": "action.invoke", "payload": {}}],
    )
    assert collect_capability_scopes(spec) == [
        Scope(kind="read", ref="query://s/p?a=1"),
        Scope(kind="write", ref="annotate"),
    ]


def test_write_action_from_event_payload() -> None:
    """When props.action is absent, event payload.action becomes the write scope (the action.button path)."""
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["f"]},
            {"id": "f", "type": "presentForm", "props": {}},
        ],
        [{"on": "f.submit", "emit": "action.invoke", "payload": {"action": "refresh"}}],
    )
    assert collect_capability_scopes(spec) == [Scope(kind="write", ref="refresh")]


def test_non_action_invoke_events_do_not_issue_write() -> None:
    """If emit is not action.invoke (e.g. intent.patch), no write scope is issued."""
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["t"]},
            {
                "id": "t",
                "type": "presentSpreadsheet",
                "props": {},
                "data": {"$ref": "query://s/p?a=1"},
            },
        ],
        [{"on": "t.rowClick", "emit": "intent.patch", "payload": {}}],
    )
    assert collect_capability_scopes(spec) == [Scope(kind="read", ref="query://s/p?a=1")]


def test_multiple_components_reads_deduped_in_component_order() -> None:
    """Reads across multiple components are concatenated in component order, and identical refs are deduplicated."""
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["a", "b", "c"]},
            {
                "id": "a",
                "type": "presentSpreadsheet",
                "props": {},
                "data": {"$ref": "query://s/p?x=1"},
            },
            {
                "id": "b",
                "type": "presentSpreadsheet",
                "props": {},
                "data": {"$ref": "query://s/p?x=2"},
            },
            {
                "id": "c",
                "type": "presentSpreadsheet",
                "props": {},
                "data": {"$ref": "query://s/p?x=1"},  # same as a → deduplicated
            },
        ],
        [],
    )
    assert collect_capability_scopes(spec) == [
        Scope(kind="read", ref="query://s/p?x=1"),
        Scope(kind="read", ref="query://s/p?x=2"),
    ]


def test_exceeds_max_bind_variants_raises() -> None:
    """If the total number of bind variants exceeds the limit (256), reject at the issuance boundary."""
    values = [str(i) for i in range(257)]
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c"]},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": "revenue"},
                "data": {
                    "$ref": "query://s/p?k=0",
                    "bind": {"k": {"$state": "k", "values": values}},
                },
            },
        ],
        [],
        kohaku="0.2",
        state={"k": "0"},
    )
    with pytest.raises(ValueError, match="exceed the limit 256"):
        collect_capability_scopes(spec)


def test_over_the_limit_throws_before_enumeration() -> None:
    """A pre-check (product of each bound param's value-set size) rejects an enormous Cartesian product
    (4 bind params x 20 values each = 160,000 combinations) before enumerate_bind_variants ever runs —
    proven by patching it and asserting it is never called, not merely by a matching error message."""
    bind = {
        f"p{p}": {"$state": f"s{p}", "values": [f"v{p}_{i}" for i in range(20)]} for p in range(4)
    }
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c"]},
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": "revenue"},
                "data": {"$ref": "query://s/p", "bind": bind},
            },
        ],
        [],
        kohaku="0.2",
    )

    with mock.patch(
        "kohaku.spec.capability_scopes.enumerate_bind_variants"
    ) as enumerate_mock:
        with pytest.raises(ValueError, match="total bind variants 160000 exceed the limit 256"):
            collect_capability_scopes(spec)
        enumerate_mock.assert_not_called()

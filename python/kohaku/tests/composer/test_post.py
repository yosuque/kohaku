"""Tests for deterministic post-processing (post rules)."""

from __future__ import annotations

from typing import Any

from kohaku.composer.post import PostProcessContext, post_process
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import DataShape, UISpec

_CATALOG = resolve_catalog(core_catalog())


def _spec(components: list[dict[str, Any]], events: list[dict[str, Any]] | None = None) -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": {"canonical": "t.v", "params": {}, "hash": "sha256:" + "0" * 64},
            "dataVersion": "v1",
            "components": components,
            "events": events or [],
            "provenance": {"tier": "L1", "composedBy": "test", "cache": "miss"},
        }
    )


def _ctx(shapes: dict[str, DataShape] | None = None) -> PostProcessContext:
    return PostProcessContext(catalog=_CATALOG, shapesByRef=shapes or {})


def test_normalize_ids_renames_dfs_and_events() -> None:
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["xyz", "abc"]},
            {"id": "xyz", "type": "text.heading", "props": {"level": 2, "text": "t"}},
            {
                "id": "abc",
                "type": "presentSpreadsheet",
                "props": {},
                "data": {"$ref": "query://s/p"},
            },
        ],
        [{"on": "abc.rowClick", "emit": "intent.patch", "payload": {}}],
    )
    out = post_process(spec, _ctx())
    assert [c.id for c in out.components] == ["root", "title1", "table1"]
    assert out.components[0].children == ["title1", "table1"]
    assert out.events[0].on == "table1.rowClick"


def test_chart_kind_time_axis_forces_line() -> None:
    shape = DataShape.model_validate(
        {"columns": [{"name": "month", "type": "date", "role": "time"},
                     {"name": "revenue", "type": "number", "role": "measure"}]}
    )
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c1"]},
            {
                "id": "c1",
                "type": "presentChart",
                "props": {"kind": "bar", "x": "month", "y": "revenue"},
                "data": {"$ref": "query://s/trend"},
            },
        ]
    )
    out = post_process(spec, _ctx({"query://s/trend": shape}))
    chart = next(c for c in out.components if c.type == "presentChart")
    assert chart.props["kind"] == "line"


def test_chart_kind_pie_with_many_rows_becomes_bar() -> None:
    shape = DataShape.model_validate(
        {"columns": [{"name": "region", "type": "string", "role": "dimension"}],
         "rowCountHint": 12}
    )
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["c1"]},
            {
                "id": "c1",
                "type": "presentChart",
                "props": {"kind": "pie", "x": "region", "y": "v"},
                "data": {"$ref": "query://s/p"},
            },
        ]
    )
    out = post_process(spec, _ctx({"query://s/p": shape}))
    chart = next(c for c in out.components if c.type == "presentChart")
    assert chart.props["kind"] == "bar"


def test_sort_order_fills_default_sort() -> None:
    shape = DataShape.model_validate(
        {"columns": [{"name": "region", "type": "string", "role": "dimension"},
                     {"name": "revenue", "type": "number", "role": "measure"}]}
    )
    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["t1"]},
            {"id": "t1", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": "query://s/p"}},
        ]
    )
    out = post_process(spec, _ctx({"query://s/p": shape}))
    table = next(c for c in out.components if c.type == "presentSpreadsheet")
    assert table.props["sortBy"] == {"field": "revenue", "dir": "desc"}


def test_canonical_props_fills_defaults_and_version() -> None:
    spec = _spec([{"id": "root", "type": "layout.stack", "props": {}}])
    out = post_process(spec, _ctx())
    node = out.components[0]
    assert node.version == "1.0.0"
    assert node.props == {"direction": "vertical", "gap": "md"}


def test_post_process_is_idempotent() -> None:
    """All rules are pure and idempotent: applying twice leaves the result unchanged."""
    from kohaku.spec import canonical_stringify

    spec = _spec(
        [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["a"]},
            {"id": "a", "type": "text.heading", "props": {"level": 2, "text": "t"}},
        ]
    )
    once = post_process(spec, _ctx())
    twice = post_process(once, _ctx())
    assert canonical_stringify(once.to_wire()) == canonical_stringify(twice.to_wire())

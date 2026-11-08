"""Tests for kohaku.domain_mcp.shape (port of shape.test.ts)."""

from __future__ import annotations

from typing import Any

import pytest

from kohaku.domain_mcp import shape_from_output_schema

ROW: dict[str, Any] = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "total": {"type": "number"},
        "qty": {"type": "integer"},
        "paid": {"type": "boolean"},
        "placedAt": {"type": "string", "format": "date-time"},
        "day": {"type": "string", "format": "date"},
        "meta": {"type": "object"},
    },
}

EXPECTED = {
    "columns": [
        {"name": "id", "type": "string", "role": "dimension"},
        {"name": "total", "type": "number", "role": "measure"},
        {"name": "qty", "type": "number", "role": "measure"},
        {"name": "paid", "type": "boolean"},
        {"name": "placedAt", "type": "date", "role": "time"},
        {"name": "day", "type": "date", "role": "time"},
    ]
}


def _dump(schema: Any) -> Any:
    shape = shape_from_output_schema(schema)
    return None if shape is None else shape.model_dump(exclude_none=True)


def test_maps_a_wrapped_rows_array() -> None:
    schema = {"type": "object", "properties": {"rows": {"type": "array", "items": ROW}}}
    assert _dump(schema) == EXPECTED


def test_maps_a_root_array_and_a_single_wrapped_array_property() -> None:
    assert _dump({"type": "array", "items": ROW}) == EXPECTED
    wrapped = {"type": "object", "properties": {"result": {"type": "array", "items": ROW}}}
    assert _dump(wrapped) == EXPECTED


@pytest.mark.parametrize(
    "schema",
    [
        None,
        {"type": "string"},
        {"type": "object", "properties": {"total": {"type": "number"}}},
        {"type": "array", "items": {"type": "string"}},
        {"type": "array", "items": {"type": "object"}},
    ],
)
def test_returns_none_when_the_schema_does_not_describe_a_list_of_objects(schema: Any) -> None:
    assert shape_from_output_schema(schema) is None

"""Tests for kohaku.domain_mcp.tabular (port of tabular.test.ts)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from kohaku.domain_mcp import McpResultError, McpToolError, to_tabular_data

from ._fakes import FakeContent, FakeResult

ROWS: list[dict[str, Any]] = [
    {"id": "o-1", "total": 10.5, "paid": True, "placedAt": "2026-04-01"},
    {"id": "o-2", "total": 3, "paid": False, "placedAt": "2026-04-02T10:00:00Z"},
]

EXPECTED_COLUMNS = [
    {"key": "id", "type": "string"},
    {"key": "total", "type": "number"},
    {"key": "paid", "type": "boolean"},
    {"key": "placedAt", "type": "date"},
]


def _wire(result: FakeResult) -> dict[str, Any]:
    return to_tabular_data(result, "v1").to_wire()


def test_reads_an_array_in_structured_content() -> None:
    assert _wire(FakeResult(structured_content=ROWS)) == {
        "columns": EXPECTED_COLUMNS,
        "rows": ROWS,
        "dataVersion": "v1",
    }


def test_reads_a_json_array_in_the_first_text_content_without_structured_content() -> None:
    result = FakeResult(content=[FakeContent(type="text", text=json.dumps(ROWS))])
    assert _wire(result)["rows"] == ROWS
    assert _wire(result)["columns"] == EXPECTED_COLUMNS


def test_accepts_an_object_whose_rows_property_is_the_array() -> None:
    wire = _wire(FakeResult(structured_content={"rows": ROWS, "note": "x"}))
    assert wire["rows"] == ROWS


def test_accepts_an_object_with_a_single_array_property() -> None:
    assert _wire(FakeResult(structured_content={"result": ROWS}))["rows"] == ROWS


def test_prefers_structured_content_over_the_text_content() -> None:
    result = FakeResult(content=[FakeContent(type="text", text="[]")], structured_content=ROWS)
    assert _wire(result)["rows"] == ROWS


def test_infers_the_columns_from_the_first_50_rows_only_in_first_appearance_order() -> None:
    rows: list[dict[str, Any]] = [{"a": i} for i in range(50)]
    rows.append({"a": 50, "late": "x"})
    data = to_tabular_data(FakeResult(structured_content=rows), "v1")
    assert [c.to_wire() for c in data.columns] == [{"key": "a", "type": "number"}]
    assert len(data.rows) == 51


def test_types_a_column_string_when_values_are_mixed_and_ignores_nulls() -> None:
    data = to_tabular_data(
        FakeResult(
            structured_content=[
                {"a": 1, "b": None, "c": {"x": 1}},
                {"a": "x", "b": 2, "c": [1]},
            ]
        ),
        "v1",
    )
    assert [c.to_wire() for c in data.columns] == [
        {"key": "a", "type": "string"},
        {"key": "b", "type": "number"},
        {"key": "c", "type": "string"},
    ]


def test_a_boolean_is_not_a_number_when_inferring_a_column() -> None:
    data = to_tabular_data(FakeResult(structured_content=[{"a": True}, {"a": 1}]), "v1")
    assert [c.to_wire() for c in data.columns] == [{"key": "a", "type": "string"}]


def test_returns_no_columns_for_an_empty_list() -> None:
    assert _wire(FakeResult(structured_content=[])) == {
        "columns": [],
        "rows": [],
        "dataVersion": "v1",
    }


@pytest.mark.parametrize(
    "result",
    [
        FakeResult(structured_content=3),
        FakeResult(structured_content={"a": 1, "b": 2}),
        FakeResult(structured_content=[1, 2]),
        FakeResult(content=[FakeContent(type="text", text="no rows today")]),
        FakeResult(content=[]),
        FakeResult(content=[FakeContent(type="image")]),
        # Python's json.loads accepts NaN / Infinity; JS JSON.parse does not, so neither side reads them.
        FakeResult(content=[FakeContent(type="text", text="[NaN]")]),
    ],
)
def test_throws_mcp_result_error(result: FakeResult) -> None:
    with pytest.raises(McpResultError):
        to_tabular_data(result, "v1")


def test_throws_mcp_tool_error_without_a_wire_code_when_the_tool_reports_is_error() -> None:
    result = FakeResult(is_error=True, content=[FakeContent(type="text", text="boom")])
    with pytest.raises(McpToolError) as info:
        to_tabular_data(result, "v1")
    assert "boom" in str(info.value)
    assert not hasattr(info.value, "code")

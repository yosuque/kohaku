"""Conversion of an MCP tool result into `TabularData` (port of tabular.ts).

Pinned to the TS implementation by the cross-language golden fixture (`domainMcp.tabular`).
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal, cast

from kohaku.spec import ColumnType, JsonObject, TabularColumn, TabularData

from .types import McpCallResult

# How many leading rows the column types are inferred from.
COLUMN_INFERENCE_ROWS = 50

# A date or date-time as ISO 8601 (extended notation). ASCII digits only, as in the TS pattern.
_DATE_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?([Zz]|[+-][0-9]{2}:[0-9]{2})?)?"
)

_MAX_ERROR_TEXT = 500


class McpToolError(RuntimeError):
    """The tool ran but reported `is_error`. No wire `code`: the upstream text must not reach a UI client."""

    def __init__(self, tool: str | None, detail: str) -> None:
        label = "" if tool is None else f' "{tool}"'
        super().__init__(f"MCP tool{label} reported an error: {detail}")


class McpResultError(ValueError):
    """The tool succeeded but its result cannot be read as a list of rows."""


def find_row_list(payload: object) -> list[Any] | None:
    """Pick the list out of a decoded tool result: the value itself when it is a list, otherwise the `rows`
    property, otherwise the only property of an object (a wrapped list such as `{"result": [...]}`). Returns
    None when no list can be found."""
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return None
    rows = payload.get("rows")
    if isinstance(rows, list):
        return rows
    if len(payload) == 1:
        only = next(iter(payload.values()))
        if isinstance(only, list):
            return only
    return None


def _text_of(result: McpCallResult) -> str:
    texts = [
        part.text
        for part in result.content
        if getattr(part, "type", None) == "text" and isinstance(getattr(part, "text", None), str)
    ]
    return "\n".join(texts)


def _reject_constant(name: str) -> object:
    # JS JSON.parse rejects NaN / Infinity / -Infinity; Python's json.loads accepts them by default.
    raise ValueError(f"invalid JSON constant {name}")


def payload_of(result: McpCallResult) -> object:
    """The decoded payload of a successful tool result: `structured_content` when present, otherwise the first
    content block when it is JSON text. Returns None when there is neither."""
    if result.structured_content is not None:
        return result.structured_content
    if len(result.content) > 0:
        first = result.content[0]
        text = getattr(first, "text", None)
        if getattr(first, "type", None) == "text" and isinstance(text, str):
            try:
                return json.loads(text, parse_constant=_reject_constant)
            except ValueError:
                return None
    return None


def assert_tool_succeeded(result: McpCallResult, tool: str | None = None) -> None:
    """Raise `McpToolError` for an `is_error` result."""
    if result.is_error:
        text = _text_of(result)
        raise McpToolError(tool, "(no detail)" if text == "" else text[:_MAX_ERROR_TEXT])


def _kind_of(value: object) -> Literal["number", "boolean", "date", "string", "other"]:
    if isinstance(value, bool):  # before int: bool is an int subclass
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "date" if _DATE_PATTERN.fullmatch(value) else "string"
    return "other"


def infer_columns(rows: list[JsonObject]) -> list[TabularColumn]:
    """Infer the columns from the first COLUMN_INFERENCE_ROWS rows: keys in first-appearance order; a column is
    `number` / `boolean` / `date` when every non-null value in the sample is of that kind, else `string`."""
    kinds: dict[str, set[str]] = {}
    for row in rows[:COLUMN_INFERENCE_ROWS]:
        for key, value in row.items():
            seen = kinds.setdefault(key, set())
            if value is not None:
                seen.add(_kind_of(value))
    columns: list[TabularColumn] = []
    for key, seen in kinds.items():
        column_type: ColumnType = "string"
        if len(seen) == 1:
            only = next(iter(seen))
            if only in ("number", "boolean", "date"):
                column_type = cast("ColumnType", only)
        columns.append(TabularColumn(key=key, type=column_type))
    return columns


def to_tabular_data(
    result: McpCallResult, data_version: str, tool: str | None = None
) -> TabularData:
    """Convert a successful MCP tool result into `TabularData`. Raises `McpToolError` for `is_error`, and
    `McpResultError` when the result is not (a wrapper around) a list of objects."""
    assert_tool_succeeded(result, tool)
    label = "" if tool is None else f' "{tool}"'
    rows_list = find_row_list(payload_of(result))
    if rows_list is None:
        raise McpResultError(
            f"MCP tool{label} returned something other than a list of rows "
            "(expected an array, or an object with a `rows` array, in structuredContent or as JSON text)"
        )
    if not all(isinstance(row, dict) for row in rows_list):
        raise McpResultError(f"MCP tool{label} returned a list whose items are not all objects")
    rows = cast("list[JsonObject]", rows_list)
    return TabularData(columns=infer_columns(rows), rows=rows, dataVersion=data_version)

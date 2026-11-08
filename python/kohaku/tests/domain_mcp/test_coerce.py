"""Tests for kohaku.domain_mcp.coerce (port of coerce.test.ts)."""

from __future__ import annotations

from typing import Any

import pytest

from kohaku.domain_mcp import McpArgumentError, coerce_tool_arguments

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "n": {"type": "number"},
        "b": {"type": "boolean"},
        "s": {"type": "string"},
        "limit": {"type": "integer"},
    },
}


def test_coerces_string_arguments_by_the_input_schema_type_and_maps_limit() -> None:
    result = coerce_tool_arguments(
        {"n": "3", "b": "true", "s": "x", "_limit": "5", "_sort": "a"}, INPUT_SCHEMA
    )
    assert result == {"n": 3, "b": True, "s": "x", "limit": 5}
    assert type(result["n"]) is int
    assert result["b"] is True


def test_never_forwards_the_reserved_parameters() -> None:
    args = {"_cursor": "c", "_limit": "2", "_sort": "s", "_dir": "asc", "s": "x"}
    assert coerce_tool_arguments(args, {"type": "object"}) == {"s": "x"}


def test_limit_wins_over_an_explicit_limit_and_is_ignored_without_a_limit_argument() -> None:
    assert coerce_tool_arguments({"limit": "9", "_limit": "5"}, INPUT_SCHEMA) == {"limit": 5}
    schema = {"type": "object", "properties": {"s": {"type": "string"}}}
    assert coerce_tool_arguments({"_limit": "5", "s": "x"}, schema) == {"s": "x"}


def test_passes_strings_through_for_string_unknown_and_untyped_properties() -> None:
    schema = {"type": "object", "properties": {"s": {"type": "string"}, "t": {}}}
    args = {"s": "1", "other": "2", "t": "true"}
    assert coerce_tool_arguments(args, schema) == {"s": "1", "other": "2", "t": "true"}


def test_keeps_values_that_are_already_typed() -> None:
    result = coerce_tool_arguments({"n": 4, "b": False}, INPUT_SCHEMA)
    assert result == {"n": 4, "b": False}
    assert result["b"] is False


def test_accepts_an_integral_decimal_for_integer_and_rejects_a_fractional_one() -> None:
    assert coerce_tool_arguments({"limit": "3.0"}, INPUT_SCHEMA) == {"limit": 3}
    with pytest.raises(McpArgumentError):
        coerce_tool_arguments({"limit": "3.5"}, INPUT_SCHEMA)


@pytest.mark.parametrize(
    "args",
    [
        {"n": "abc"},
        {"n": ""},
        {"n": " 3"},
        {"n": "0x10"},
        {"n": "01"},
        {"n": "1e400"},
        {"b": "yes"},
        {"b": "True"},
        {"_limit": "many"},
        # Python's \d would accept Arabic-Indic digits; the grammar is ASCII-only, as in JS.
        {"n": "٣"},
    ],
)
def test_throws_action_params_invalid(args: dict[str, Any]) -> None:
    with pytest.raises(McpArgumentError) as info:
        coerce_tool_arguments(args, INPUT_SCHEMA)
    assert info.value.code == "ACTION_PARAMS_INVALID"


def test_reads_the_type_through_a_nullable_any_of() -> None:
    nullable: dict[str, Any] = {
        "type": "object",
        "properties": {
            "limit": {"anyOf": [{"type": "integer"}, {"type": "null"}], "default": None},
            "flag": {"anyOf": [{"type": "null"}, {"type": "boolean"}]},
            "either": {"anyOf": [{"type": "integer"}, {"type": "string"}]},
        },
    }
    assert coerce_tool_arguments({"limit": "5", "flag": "true", "either": "7"}, nullable) == {
        "limit": 5,
        "flag": True,
        "either": "7",
    }
    with pytest.raises(McpArgumentError):
        coerce_tool_arguments({"limit": "x"}, nullable)


def test_tolerates_an_input_schema_without_properties() -> None:
    assert coerce_tool_arguments({"a": "1"}, {"type": "object"}) == {"a": "1"}

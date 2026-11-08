"""Tests for kohaku.domain_mcp.schema_projection (port of schema-projection.test.ts)."""

from __future__ import annotations

from typing import Any

import pytest

from kohaku.domain_mcp import project_input_schema
from kohaku.spec import assert_valid_action_params_schema


def test_drops_annotation_keywords_closes_the_schema_and_reports_what_was_dropped() -> None:
    result = project_input_schema(
        {
            "type": "object",
            "properties": {"q": {"type": "string", "description": "x", "maxLength": 10}},
            "required": ["q"],
        }
    )
    assert result.schema == {
        "type": "object",
        "properties": {"q": {"type": "string", "maxLength": 10}},
        "required": ["q"],
        "additionalProperties": False,
    }
    assert result.dropped == ["properties.q.description"]
    assert result.omitted is False
    assert result.reasons == []


def test_produces_a_schema_the_closed_action_params_subset_accepts() -> None:
    result = project_input_schema(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "title": "refund",
            "properties": {
                "orderId": {"type": "string", "pattern": "^o-", "minLength": 1, "format": "uuid"},
                "amount": {"type": "number", "minimum": 0, "maximum": 1000, "default": 5},
                "qty": {"type": "integer", "exclusiveMinimum": 0},
                "mode": {"type": "string", "enum": ["full", "partial"]},
                "notify": {"type": "boolean"},
                "tags": {
                    "type": "array",
                    "items": {"type": "string", "maxLength": 8},
                    "maxItems": 4,
                    "minItems": 1,
                },
                "nested": {"type": "object", "properties": {"a": {"type": "string"}}},
            },
            "required": ["orderId", "amount"],
            "additionalProperties": False,
        }
    )
    assert result.omitted is False
    assert result.schema is not None
    assert_valid_action_params_schema("refund", result.schema)
    assert result.dropped == [
        "$schema",
        "title",
        "properties.orderId.pattern",
        "properties.orderId.format",
        "properties.amount.default",
        "properties.qty.exclusiveMinimum",
        "properties.tags.minItems",
    ]
    # Nested objects are closed too, and an already-closed root stays closed.
    assert result.schema["additionalProperties"] is False
    assert result.schema["properties"]["nested"]["additionalProperties"] is False


def test_closes_a_property_less_object_schema() -> None:
    assert project_input_schema({"type": "object"}).schema == {
        "type": "object",
        "additionalProperties": False,
    }


_UNREPRESENTABLE: list[tuple[str, Any]] = [
    (
        "anyOf",
        {
            "type": "object",
            "properties": {"a": {"anyOf": [{"type": "string"}, {"type": "number"}]}},
        },
    ),
    ("oneOf", {"type": "object", "oneOf": [{"properties": {}}]}),
    (
        "$ref",
        {
            "type": "object",
            "properties": {"a": {"$ref": "#/$defs/A"}},
            "$defs": {"A": {"type": "string"}},
        },
    ),
    ("a type array", {"type": "object", "properties": {"a": {"type": ["string", "null"]}}}),
    ("additionalProperties: true", {"type": "object", "additionalProperties": True}),
    (
        "an additionalProperties schema",
        {"type": "object", "additionalProperties": {"type": "string"}},
    ),
    (
        "a tuple items",
        {"type": "object", "properties": {"a": {"type": "array", "items": [{"type": "string"}]}}},
    ),
    ("a non-object root", {"type": "string"}),
    ("a typeless node", {"type": "object", "properties": {"a": {}}}),
    (
        "a malformed enum",
        {"type": "object", "properties": {"a": {"type": "string", "enum": [{"x": 1}]}}},
    ),
    (
        "a fractional maxLength",
        {"type": "object", "properties": {"a": {"type": "string", "maxLength": 1.5}}},
    ),
    (
        "an unknown keyword",
        {"type": "object", "properties": {"a": {"type": "string", "someVendorThing": 1}}},
    ),
]


@pytest.mark.parametrize(
    ("label", "schema"), _UNREPRESENTABLE, ids=[c[0] for c in _UNREPRESENTABLE]
)
def test_omits_the_schema_when_it_cannot_be_represented(label: str, schema: Any) -> None:
    result = project_input_schema(schema)
    assert result.omitted is True
    assert result.schema is None
    assert len(result.reasons) > 0


def test_names_the_offending_path_in_reasons() -> None:
    result = project_input_schema(
        {"type": "object", "properties": {"a": {"anyOf": [{"type": "string"}]}}}
    )
    assert result.reasons == ["properties.a.anyOf"]


def test_omits_when_the_input_is_not_an_object_at_all() -> None:
    for value in (None, True):
        result = project_input_schema(value)
        assert result.schema is None
        assert result.omitted is True


def test_a_boolean_is_not_a_number_for_the_numeric_keywords() -> None:
    result = project_input_schema(
        {"type": "object", "properties": {"a": {"type": "number", "minimum": True}}}
    )
    assert result.omitted is True

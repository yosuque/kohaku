"""Unit tests for kohaku.spec.action_params (port of packages/spec-core/test/action-params.test.ts).

Byte-for-byte parity with the TS implementation is pinned separately by test_cross_language_golden.py's
test_action_params; this file exercises the same behaviors directly (including cases that are awkward to
express as a shared JSON fixture, like exception types).
"""

from __future__ import annotations

import pytest

from kohaku.spec.action_params import (
    ActionParamsSchema,
    ActionParamsSchemaError,
    action_payload_hash,
    assert_valid_action_params_schema,
    validate_action_params,
)

NOTE_SCHEMA: ActionParamsSchema = {
    "type": "object",
    "properties": {"note": {"type": "string", "maxLength": 500}},
    "required": ["note"],
    "additionalProperties": False,
}


def test_valid_payload_has_no_issues() -> None:
    assert validate_action_params(NOTE_SCHEMA, {"note": "hello"}) == []


def test_missing_required_property() -> None:
    issues = validate_action_params(NOTE_SCHEMA, {})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("note", "required", 'missing required property "note"')
    ]


def test_unexpected_property_when_additional_properties_false() -> None:
    issues = validate_action_params(NOTE_SCHEMA, {"note": "hi", "extra": 1})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("extra", "additionalProperties", 'unexpected property "extra"')
    ]


def test_type_mismatch_at_property_path() -> None:
    issues = validate_action_params(NOTE_SCHEMA, {"note": 42})
    assert [(i.path, i.code, i.message) for i in issues] == [("note", "type", 'expected a string at "note"')]


def test_min_length_and_max_length() -> None:
    schema: ActionParamsSchema = {
        "type": "object",
        "properties": {"s": {"type": "string", "minLength": 2, "maxLength": 4}},
    }
    issues = validate_action_params(schema, {"s": "a"})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("s", "minLength", "expected at least 2 characters")
    ]
    issues = validate_action_params(schema, {"s": "abcde"})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("s", "maxLength", "expected at most 4 characters")
    ]


def test_minimum_maximum_and_integer_rejection() -> None:
    schema: ActionParamsSchema = {
        "type": "object",
        "properties": {"n": {"type": "integer", "minimum": 0, "maximum": 10}},
    }

    def issues_for(value: int | float | bool) -> list[tuple[str, str, str]]:
        return [(i.path, i.code, i.message) for i in validate_action_params(schema, {"n": value})]

    assert issues_for(-1) == [("n", "minimum", "expected at least 0")]
    assert issues_for(11) == [("n", "maximum", "expected at most 10")]
    assert issues_for(1.5) == [("n", "type", 'expected an integer at "n"')]
    assert issues_for(True) == [("n", "type", 'expected an integer at "n"')]  # bool must not pass as a number
    assert issues_for(5) == []


def test_enum_violation() -> None:
    schema: ActionParamsSchema = {"type": "object", "properties": {"s": {"type": "string", "enum": ["a", "b"]}}}
    issues = validate_action_params(schema, {"s": "c"})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("s", "enum", 'expected one of ["a","b"]')
    ]


def test_array_items_and_max_items_with_index_paths() -> None:
    schema: ActionParamsSchema = {
        "type": "object",
        "properties": {
            "tags": {"type": "array", "items": {"type": "string", "maxLength": 3}, "maxItems": 2}
        },
    }
    issues = validate_action_params(schema, {"tags": ["ok", "toolong", "x"]})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("tags", "maxItems", "expected at most 2 items"),
        ("tags[1]", "maxLength", "expected at most 3 characters"),
    ]


def test_nested_object_dot_paths() -> None:
    schema: ActionParamsSchema = {
        "type": "object",
        "properties": {
            "address": {
                "type": "object",
                "properties": {"city": {"type": "string", "minLength": 1}},
                "required": ["city"],
            }
        },
    }
    issues = validate_action_params(schema, {"address": {"city": ""}})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("address.city", "minLength", "expected at least 1 characters")
    ]


def test_x_message_override() -> None:
    schema: ActionParamsSchema = {
        "type": "object",
        "properties": {"note": {"type": "string", "maxLength": 3, "x-message": "note is too long"}},
    }
    issues = validate_action_params(schema, {"note": "abcd"})
    assert [(i.path, i.code, i.message) for i in issues] == [("note", "maxLength", "note is too long")]


def test_boolean_type_and_type_mismatch() -> None:
    schema: ActionParamsSchema = {"type": "object", "properties": {"flag": {"type": "boolean"}}}
    assert validate_action_params(schema, {"flag": True}) == []
    issues = validate_action_params(schema, {"flag": "yes"})
    assert [(i.path, i.code, i.message) for i in issues] == [
        ("flag", "type", 'expected a boolean at "flag"')
    ]


def test_assert_valid_action_params_schema_accepts_the_allowed_subset() -> None:
    assert_valid_action_params_schema("annotate", NOTE_SCHEMA)


def test_assert_valid_action_params_schema_rejects_pattern() -> None:
    with pytest.raises(ActionParamsSchemaError):
        assert_valid_action_params_schema("annotate", {"type": "string", "pattern": "^[a-z]+$"})


def test_assert_valid_action_params_schema_rejects_additional_properties_true() -> None:
    with pytest.raises(ActionParamsSchemaError):
        assert_valid_action_params_schema("annotate", {"type": "object", "additionalProperties": True})


def test_action_payload_hash_is_deterministic_and_key_order_independent() -> None:
    a = action_payload_hash({"note": "hi", "id": 1})
    b = action_payload_hash({"id": 1, "note": "hi"})
    assert a == b
    assert a.startswith("sha256:")
    assert len(a) == len("sha256:") + 64


def test_action_payload_hash_differs_for_a_different_payload() -> None:
    a = action_payload_hash({"note": "hi"})
    b = action_payload_hash({"note": "bye"})
    assert a != b

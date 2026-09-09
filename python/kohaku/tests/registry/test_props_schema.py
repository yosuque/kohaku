"""Tests for PropsSchema (a JSON Schema validator with zod-strip semantics)."""

from __future__ import annotations

from kohaku.registry import PropsSchema, props_schema_from_json_schema


def _form_fields_schema() -> PropsSchema:
    """A schema containing a union equivalent to presentForm's options (string | {value,label})."""
    return PropsSchema(
        {
            "type": "object",
            "properties": {
                "options": {
                    "type": "array",
                    "items": {
                        "anyOf": [
                            {"type": "string"},
                            {
                                "type": "object",
                                "properties": {
                                    "value": {"type": "string"},
                                    "label": {"type": "string"},
                                },
                                "required": ["value", "label"],
                            },
                        ]
                    },
                },
            },
            "required": [],
        }
    )


class TestSafeParse:
    def test_default_filling_overrides_required(self) -> None:
        """zod's toJSONSchema lists default-bearing fields in required too, but a missing one is filled with the default."""
        schema = PropsSchema(
            {
                "type": "object",
                "properties": {"gap": {"type": "string", "enum": ["sm", "md"], "default": "md"}},
                "required": ["gap"],
            }
        )
        result = schema.safe_parse({})
        assert result.ok and result.value == {"gap": "md"}

    def test_missing_required_without_default_fails(self) -> None:
        schema = PropsSchema(
            {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            }
        )
        result = schema.safe_parse({})
        assert not result.ok and result.error is not None

    def test_union_accepts_both_branches(self) -> None:
        schema = _form_fields_schema()
        ok = schema.safe_parse({"options": ["a", {"value": "b", "label": "B"}]})
        assert ok.ok
        bad = schema.safe_parse({"options": [1]})
        assert not bad.ok

    def test_integer_rejects_fraction_and_bool(self) -> None:
        schema = PropsSchema(
            {
                "type": "object",
                "properties": {"n": {"type": "integer", "minimum": 1, "maximum": 6}},
                "required": ["n"],
            }
        )
        assert schema.safe_parse({"n": 3}).ok
        assert schema.safe_parse({"n": 3.0}).ok  # zod .int() lets 3.0 through
        assert not schema.safe_parse({"n": 3.5}).ok
        assert not schema.safe_parse({"n": True}).ok  # bool is not a number
        assert not schema.safe_parse({"n": 0}).ok

    def test_exclusive_minimum(self) -> None:
        schema = PropsSchema(
            {
                "type": "object",
                "properties": {"n": {"type": "number", "exclusiveMinimum": 0}},
                "required": ["n"],
            }
        )
        assert schema.safe_parse({"n": 0.1}).ok
        assert not schema.safe_parse({"n": 0}).ok

    def test_top_level_non_object_fails(self) -> None:
        schema = PropsSchema({"type": "object", "properties": {}})
        assert not schema.safe_parse("not an object").ok


def test_from_json_schema_total_conversion() -> None:
    """A non-object / missing schema falls back to loose validation and does not throw."""
    permissive = props_schema_from_json_schema(None)
    assert permissive.safe_parse({"anything": [1, 2, 3]}).ok
    permissive2 = props_schema_from_json_schema({"type": "string"})
    assert permissive2.safe_parse({"x": 1}).ok

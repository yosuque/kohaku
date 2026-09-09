"""Tests for the L1 generation schema (build_generation_schema)."""

from __future__ import annotations

from typing import Any

import pytest

from kohaku.registry import (
    build_generation_schema,
    core_catalog,
    resolve_catalog,
    select_generation_types,
    strip_nulls,
    to_generation_props_schema,
)

_CATALOG = resolve_catalog(core_catalog())


class TestSelectGenerationTypes:
    def test_excluded_types_are_absent(self) -> None:
        types = select_generation_types(_CATALOG)
        assert "ui.loading" not in types  # generation:"excluded"
        assert "control.select" not in types
        assert "layout.tabs" not in types
        assert "presentChart" in types

    def test_include_types_unions_guardrails(self) -> None:
        types = select_generation_types(_CATALOG, ["presentChart"])
        assert set(types) == {"presentChart", "layout.stack", "presentMarkdown"}

    def test_unknown_include_falls_back_to_all(self) -> None:
        """If none of the specified types exist in the catalog, use all (to prevent an unrecoverable empty vocabulary)."""
        all_types = select_generation_types(_CATALOG)
        assert select_generation_types(_CATALOG, ["no.such"]) == all_types


class TestBuildGenerationSchema:
    def test_data_refs_are_enum_locked(self) -> None:
        """$ref is pinned to an enum of resolved URIs (schema-level sealing against reference forgery)."""
        refs = ["query://s/a", "query://s/b"]
        schema = build_generation_schema(_CATALOG, refs)
        variants = schema.jsonSchema["properties"]["components"]["items"]["anyOf"]
        chart = next(v for v in variants if v["properties"]["type"]["const"] == "presentChart")
        assert chart["properties"]["data"]["properties"]["$ref"]["enum"] == refs

    def test_variants_exclude_generation_excluded(self) -> None:
        schema = build_generation_schema(_CATALOG, [])
        variants = schema.jsonSchema["properties"]["components"]["items"]["anyOf"]
        types = {v["properties"]["type"]["const"] for v in variants}
        assert "ui.loading" not in types

    def test_event_emit_excludes_state_set(self) -> None:
        schema = build_generation_schema(_CATALOG, [])
        event_schema = schema.jsonSchema["properties"]["events"]["items"]
        assert event_schema["properties"]["emit"]["enum"] == [
            "intent.patch",
            "intent.replace",
            "action.invoke",
        ]

    def test_decode_pairs_to_payload(self) -> None:
        schema = build_generation_schema(_CATALOG, [])
        draft = schema.decode(
            {
                "components": [{"id": "root", "type": "layout.stack", "props": None}],
                "events": [
                    {
                        "on": "a.click",
                        "emit": "intent.patch",
                        "payload": [{"key": "region", "value": "$row.region"}],
                    }
                ],
            }
        )
        assert draft.components[0]["props"] == {}
        assert draft.events[0]["payload"] == {"region": "$row.region"}

    def test_decode_rejects_malformed(self) -> None:
        schema = build_generation_schema(_CATALOG, [])
        with pytest.raises(ValueError, match="components is not an array"):
            schema.decode({"components": "x"})
        with pytest.raises(ValueError, match="on is not a string"):
            schema.decode({"components": [], "events": [{"on": 1, "emit": "intent.patch"}]})


class TestGenerationPropsSchema:
    def test_optional_becomes_nullable_and_all_required(self) -> None:
        src: dict[str, Any] = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "a": {"type": "string", "default": "x"},
                "b": {"type": "number"},
            },
            "required": ["a"],
        }
        out = to_generation_props_schema(src)
        assert "$schema" not in out
        assert out["required"] == ["a", "b"]
        assert out["additionalProperties"] is False
        assert out["properties"]["a"] == {"type": "string"}  # default removed; required passes through
        assert out["properties"]["b"] == {"anyOf": [{"type": "number"}, {"type": "null"}]}


def test_strip_nulls() -> None:
    assert strip_nulls({"a": 1, "b": None, "c": {"d": None, "e": 2}}) == {"a": 1, "c": {"e": 2}}
    # null array elements are kept (only object properties are removed)
    assert strip_nulls([1, None, {"a": None}]) == [1, None, {}]

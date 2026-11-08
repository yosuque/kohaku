"""Port of packages/semantic-llm/test/catalog.test.ts (1:1)."""

from __future__ import annotations

import pytest

from kohaku.intents import (
    IntentSpec,
    QueryTemplate,
    define_intent,
    define_vocabulary,
    number,
    object_schema,
)
from kohaku.semantic_llm import create_intent_catalog
from kohaku.spec import JsonObject

region = define_vocabulary("region", {"japan": "Japan", "europe": "Europe"})
summary = define_intent(
    IntentSpec(
        canonical="sales.summary",
        description="Summary",
        source="sales",
        params=object_schema(
            {"region": region.enum().optional(), "topN": number(integer=True).default(5)}
        ),
        examples=["summary"],
        queries=[QueryTemplate(path="summary", paramMap={"region": "region", "topN": "topN"})],
    )
).to_intent_def()


def test_lists_names_gets_a_definition_and_normalizes_params_with_defaults() -> None:
    catalog = create_intent_catalog([summary])
    assert catalog.names() == ["sales.summary"]
    found = catalog.get("sales.summary")
    assert found is not None
    assert found.description == "Summary"
    assert catalog.normalize_params("sales.summary", {"region": "japan"}) == {
        "region": "japan",
        "topN": 5,
    }
    assert catalog.normalize_params("sales.summary", {"region": "mars"}) is None
    assert catalog.normalize_params("unknown", {}) is None


def test_add_remove_mutate_the_catalog() -> None:
    from dataclasses import replace

    catalog = create_intent_catalog([summary])
    catalog.add(replace(summary, name="sales.promoted"))
    assert catalog.names() == ["sales.summary", "sales.promoted"]
    catalog.remove("sales.promoted")
    assert catalog.names() == ["sales.summary"]


def test_revision_moves_only_on_an_actual_mutation() -> None:
    from dataclasses import replace

    catalog = create_intent_catalog([summary])
    initial = catalog.revision
    catalog.add(replace(summary, name="sales.promoted"))
    assert catalog.revision == initial + 1
    catalog.remove("does-not-exist")
    assert catalog.revision == initial + 1
    catalog.remove("sales.promoted")
    assert catalog.revision == initial + 2


class TestValidateParams:
    def test_accepts_valid_params_and_returns_the_normalized_form(self) -> None:
        catalog = create_intent_catalog([summary])
        result = catalog.validate_params("sales.summary", {"region": "japan"})
        assert result.ok is True
        assert result.params == {"region": "japan", "topN": 5}

    def test_rejects_an_unknown_intent_name_with_a_single_whole_intent_issue(self) -> None:
        catalog = create_intent_catalog([summary])
        result = catalog.validate_params("sales.unknown", {})
        assert result.ok is False
        assert [(i.path, i.message) for i in result.issues] == [
            ("", 'unknown intent "sales.unknown"')
        ]

    def test_rejects_an_invalid_param_value_with_a_path_scoped_issue(self) -> None:
        catalog = create_intent_catalog([summary])
        result = catalog.validate_params("sales.summary", {"region": "mars"})
        assert result.ok is False
        assert len(result.issues) == 1
        assert result.issues[0].path == "region"
        assert "region" in result.issues[0].message

    def test_rejects_an_unknown_param_key_that_normalize_params_would_silently_strip(
        self,
    ) -> None:
        catalog = create_intent_catalog([summary])
        # normalize_params (a plain safe_parse) silently drops the unknown key and succeeds.
        assert catalog.normalize_params("sales.summary", {"region": "japan", "bogus": 1}) == {
            "region": "japan",
            "topN": 5,
        }
        # validate_params treats the same input as invalid instead.
        result = catalog.validate_params("sales.summary", {"region": "japan", "bogus": 1})
        assert result.ok is False
        assert [(i.path, i.message) for i in result.issues] == [("bogus", 'unknown param "bogus"')]

    @pytest.mark.parametrize("key", ["constructor", "toString", "__proto__", "hasOwnProperty"])
    def test_reports_object_prototype_names_as_unknown_keys(self, key: str) -> None:
        # TS parametrizes over Object.prototype names; they are plain undeclared keys here too.
        catalog = create_intent_catalog([summary])
        params: JsonObject = {"region": "japan", key: 1}
        result = catalog.validate_params("sales.summary", params)
        assert result.ok is False
        assert [(i.path, i.message) for i in result.issues] == [(key, f'unknown param "{key}"')]

    def test_reports_both_an_unknown_key_and_an_invalid_value_together(self) -> None:
        catalog = create_intent_catalog([summary])
        result = catalog.validate_params("sales.summary", {"region": "mars", "bogus": 1})
        assert result.ok is False
        assert sorted(i.path for i in result.issues) == ["bogus", "region"]

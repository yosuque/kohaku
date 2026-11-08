"""Port of packages/semantic-llm/test/prompt.test.ts (1:1)."""

from __future__ import annotations

from kohaku.intents import IntentDef, IntentSpec, define_intent, object_schema
from kohaku.semantic_llm import create_intent_catalog, render_catalog_doc
from kohaku.spec import JsonObject

summary = define_intent(
    IntentSpec(
        canonical="sales.summary",
        description="Summary",
        source="sales",
        params=object_schema({}),
        examples=[],
        queries=[],
    )
).to_intent_def()

promoted = define_intent(
    IntentSpec(
        canonical="sales.promoted",
        description="A promoted Intent",
        source="sales",
        params=object_schema({}),
        examples=[],
        queries=[],
    )
).to_intent_def()


class TestRenderCatalogDocRevisionAwareCaching:
    def test_recomputes_after_catalog_add_mutates_the_same_object(self) -> None:
        catalog = create_intent_catalog([summary])
        before = render_catalog_doc(catalog)
        assert "sales.promoted" not in before

        catalog.add(promoted)
        after = render_catalog_doc(catalog)
        assert "### sales.promoted\nA promoted Intent" in after

    def test_recomputes_after_catalog_remove_mutates_the_same_object(self) -> None:
        catalog = create_intent_catalog([summary, promoted])
        before = render_catalog_doc(catalog)
        assert "sales.promoted" in before

        catalog.remove("sales.promoted")
        after = render_catalog_doc(catalog)
        assert "sales.promoted" not in after

    def test_a_catalog_without_a_revision_is_still_memoized_purely_on_object_identity(self) -> None:
        class Stub:
            """An immutable / revision-less IntentCatalogLike implementation (no `revision`)."""

            def __init__(self) -> None:
                self.list_calls = 0

            def get(self, name: str) -> IntentDef | None:
                return None

            def list_defs(self) -> list[IntentDef]:
                self.list_calls += 1
                return [summary]

            def names(self) -> list[str]:
                return ["sales.summary"]

            def normalize_params(self, name: str, params: JsonObject) -> JsonObject | None:
                return params

        stub = Stub()
        first = render_catalog_doc(stub)
        second = render_catalog_doc(stub)
        assert second == first
        assert stub.list_calls == 1

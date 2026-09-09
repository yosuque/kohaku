"""Test for the promotion -> component / Intent mapping (port of TS: apps/sample-api/src/intents/promoted.ts).

Checks promoted_component (sandbox-template registration) and promoted_intent (default params / queryTemplate path).
"""

from __future__ import annotations

import pytest

from kohaku.intents import IntentDef, ParamError
from kohaku.lineage import ComponentDraft, QueryTemplate
from sales_api.promoted import PromotedEntry, promoted_component, promoted_intent


def _entry(draft: ComponentDraft, request: str | None = None) -> PromotedEntry:
    return PromotedEntry(
        artifactId="art-1",
        draft=draft,
        html="<div>heat</div>",
        request=request,
        publishedAt="2026-07-02T00:00:00.000Z",
    )


class TestPromotedComponent:
    def test_registers_as_sandbox_template(self) -> None:
        draft = ComponentDraft(
            componentType="sales.heatmap",
            version="1.0.0",
            intentName="sales.heatmap_view",
            description="Sales heatmap",
        )
        comp = promoted_component(_entry(draft))
        assert comp.type == "sales.heatmap"
        assert comp.version == "1.0.0"
        assert comp.implementation.kind == "sandbox-template"
        assert comp.implementation.html == "<div>heat</div>"
        assert comp.capabilities.data == "required"
        assert comp.fallback is not None and comp.fallback.type == "presentMarkdown"


class TestPromotedIntentTemplate:
    def test_query_template_path(self) -> None:
        draft = ComponentDraft(
            componentType="sales.heatmap",
            version="1.0.0",
            intentName="sales.heatmap_view",
            description="Sales heatmap",
            paramsJsonSchema={
                "type": "object",
                "properties": {"fiscalYear": {"type": "integer", "default": 2026}},
            },
            queryTemplate=QueryTemplate(
                path="trend",
                paramMap={"fiscalYear": "fy"},
                fixedParams={"metric": "revenue", "granularity": "month"},
            ),
        )
        intent = promoted_intent(_entry(draft, request="as a heatmap"))
        assert intent.name == "sales.heatmap_view"
        assert intent.examples == ["as a heatmap"]
        # Coerce GUI-origin string input (paramsJsonSchema's integer -> number(int)).
        params = intent.params.parse({"fiscalYear": "2026"})
        assert params == {"fiscalYear": 2026}
        uris = [q.uri for q in intent.to_queries(params)]
        assert uris == ["query://sales/trend?fy=2026&granularity=month&metric=revenue"]


class TestPromotedIntentDefault:
    def test_default_params_and_trend_fallback(self) -> None:
        draft = ComponentDraft(
            componentType="sales.widget",
            version="1.0.0",
            intentName="sales.widget_view",
            description="Sales widget",
        )
        intent = promoted_intent(_entry(draft))
        # request unspecified -> examples is the description.
        assert intent.examples == ["Sales widget"]
        # Default params: fiscalYear default 2026 / region optional.
        assert intent.params.parse({}) == {"fiscalYear": 2026}
        uris = [q.uri for q in intent.to_queries(intent.params.parse({}))]
        assert uris == ["query://sales/trend?fy=2026&granularity=month&metric=revenue"]

    def test_default_params_with_region(self) -> None:
        draft = ComponentDraft(
            componentType="sales.widget",
            version="1.0.0",
            intentName="sales.widget_view",
            description="Sales widget",
        )
        intent = promoted_intent(_entry(draft))
        params = intent.params.parse({"region": "japan"})
        assert params == {"fiscalYear": 2026, "region": "japan"}
        uris = [q.uri for q in intent.to_queries(params)]
        assert uris == [
            "query://sales/trend?fy=2026&granularity=month&metric=revenue&region=japan"
        ]


class TestPromotedIntentBooleanCoerce:
    """Checks that the coerce of a boolean param conforms to TS (the explicit mapping of z.coerce.boolean).

    Previously, the Python param DSL had no boolean and fell back to string() (a behavioral difference).
    Now _BooleanField accepts "true"/"1"/true -> True, "false"/"0"/false -> False, and unsupported types pass through.
    """

    def _intent_with(self, schema: dict[str, object]) -> IntentDef:
        draft = ComponentDraft(
            componentType="sales.widget",
            version="1.0.0",
            intentName="sales.widget_view",
            description="Sales widget",
            paramsJsonSchema={"type": "object", "properties": schema},
        )
        return promoted_intent(_entry(draft))

    def test_boolean_string_inputs_coerce(self) -> None:
        intent = self._intent_with({"compact": {"type": "boolean"}})
        # Under the old implementation (string fallback), "true"/"false" would have passed through as strings.
        assert intent.params.parse({"compact": "true"}) == {"compact": True}
        assert intent.params.parse({"compact": "1"}) == {"compact": True}
        assert intent.params.parse({"compact": "false"}) == {"compact": False}
        assert intent.params.parse({"compact": "0"}) == {"compact": False}
        # A boolean itself passes through as-is.
        assert intent.params.parse({"compact": True}) == {"compact": True}

    def test_boolean_rejects_non_boolean_like(self) -> None:
        intent = self._intent_with({"compact": {"type": "boolean"}})
        with pytest.raises(ParamError):
            intent.params.parse({"compact": "maybe"})

    def test_unknown_type_passes_through(self) -> None:
        # Unsupported types (equivalent to z.unknown) pass through without coercing or validating.
        intent = self._intent_with({"blob": {"type": "array"}})
        assert intent.params.parse({"blob": [1, 2]}) == {"blob": [1, 2]}

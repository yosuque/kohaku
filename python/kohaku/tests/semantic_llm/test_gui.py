"""Port of packages/semantic-llm/test/gui.test.ts (1:1)."""

from __future__ import annotations

import pytest

from kohaku.intents import (
    DrilldownResult,
    EnumField,
    IntentSpec,
    QueryTemplate,
    define_intent,
    define_vocabulary,
    number,
    object_schema,
)
from kohaku.semantic_llm import create_intent_catalog, normalize_gui_action
from kohaku.spec import (
    GuiAction,
    Intent,
    IntentInput,
    JsonObject,
    finalize_intent,
    js_string,
)

region = define_vocabulary("region", {"japan": "Japan", "europe": "Europe"})


def _drilldown(current: JsonObject, payload: JsonObject) -> DrilldownResult:
    raw = payload.get("drilldown")
    text = "" if raw is None else js_string(raw)
    reversed_code = region.reverse_label(text)
    clicked = text if reversed_code is None else reversed_code
    return DrilldownResult(params={**current, "region": clicked, "groupBy": "product"})


catalog = create_intent_catalog(
    [
        define_intent(
            IntentSpec(
                canonical="sales.summary",
                description="Summary",
                source="sales",
                params=object_schema(
                    {
                        "region": region.enum().optional(),
                        "groupBy": EnumField(values=("region", "product")).default("region"),
                    }
                ),
                examples=[],
                queries=[
                    QueryTemplate(
                        path="summary", paramMap={"region": "region", "groupBy": "groupBy"}
                    )
                ],
                drilldown=_drilldown,
            )
        ).to_intent_def(),
        define_intent(
            IntentSpec(
                canonical="sales.records",
                description="Records",
                source="sales",
                params=object_schema({"limit": number(integer=True).default(100)}),
                examples=[],
                queries=[QueryTemplate(path="records", paramMap={"limit": "limit"})],
            )
        ).to_intent_def(),
    ]
)


def _current(canonical: str, params: JsonObject) -> Intent:
    return finalize_intent(IntentInput(canonical=canonical, params=params))


def test_view_select_picks_the_intent_and_merges_facets_over_current_params_of_the_same_intent() -> (
    None
):
    out = normalize_gui_action(
        GuiAction(
            kind="gui",
            action="view.select",
            params={"intent": "sales.summary", "region": "japan"},
            current=_current("sales.summary", {"groupBy": "product"}),
        ),
        catalog,
    )
    assert out == IntentInput(
        canonical="sales.summary", params={"region": "japan", "groupBy": "product"}
    )


def test_facet_change_onto_a_different_intent_does_not_carry_the_old_params_over() -> None:
    out = normalize_gui_action(
        GuiAction(
            kind="gui",
            action="facet.change",
            params={"intent": "sales.records"},
            current=_current("sales.summary", {"groupBy": "product"}),
        ),
        catalog,
    )
    assert out == IntentInput(canonical="sales.records", params={"limit": 100})


def test_a_component_event_delegates_to_the_intents_drilldown() -> None:
    out = normalize_gui_action(
        GuiAction(
            kind="gui",
            action="table1.rowClick",
            params={"drilldown": "Japan"},
            current=_current("sales.summary", {"groupBy": "region"}),
        ),
        catalog,
    )
    assert out == IntentInput(
        canonical="sales.summary", params={"groupBy": "product", "region": "japan"}
    )


def test_a_component_event_without_a_drilldown_merges_the_payload_into_the_current_params() -> None:
    out = normalize_gui_action(
        GuiAction(
            kind="gui",
            action="list.more",
            params={"limit": 200},
            current=_current("sales.records", {"limit": 100}),
        ),
        catalog,
    )
    assert out == IntentInput(canonical="sales.records", params={"limit": 200})


def test_view_select_facet_change_without_params_intent_or_a_current_intent_throws() -> None:
    with pytest.raises(
        ValueError, match="^view.select requires params.intent or a current Intent$"
    ):
        normalize_gui_action(GuiAction(kind="gui", action="view.select", params={}), catalog)
    with pytest.raises(
        ValueError, match="^facet.change requires params.intent or a current Intent$"
    ):
        normalize_gui_action(GuiAction(kind="gui", action="facet.change", params={}), catalog)


def test_rejects_unknown_intents_invalid_params_and_unsupported_actions() -> None:
    with pytest.raises(ValueError, match="unknown intent"):
        normalize_gui_action(
            GuiAction(kind="gui", action="view.select", params={"intent": "nope"}), catalog
        )
    with pytest.raises(ValueError, match="invalid params"):
        normalize_gui_action(
            GuiAction(
                kind="gui",
                action="view.select",
                params={"intent": "sales.summary", "region": "mars"},
            ),
            catalog,
        )
    with pytest.raises(ValueError, match="unsupported gui action"):
        normalize_gui_action(GuiAction(kind="gui", action="whatever", params={}), catalog)

"""Tests for define_intent (the same scenarios as TS intent.test.ts)."""

from __future__ import annotations

import pytest

from kohaku.intents import (
    DrilldownResult,
    FacetSpec,
    FacetView,
    IntentDefinition,
    IntentSpec,
    QueryTemplate,
    define_intent,
    define_vocabulary,
    number,
    object_schema,
    string,
)
from kohaku.spec import JsonObject, QueryHandle, js_string

region = define_vocabulary(
    "region",
    {"japan": "Japan", "north_america": "North America", "europe": "Europe", "apac": "APAC"},
)
group_by = define_vocabulary(
    "groupBy",
    {"region": "By region", "product": "By product", "channel": "By channel"},
)


def _summary_drilldown(current: JsonObject, payload: JsonObject) -> DrilldownResult:
    raw = payload.get("drilldown")
    clicked = "" if raw is None else js_string(raw)
    reversed_code = region.reverse_label(clicked)
    code = clicked if reversed_code is None else reversed_code
    if current.get("groupBy") == "region" and code != "":
        return DrilldownResult(params={**current, "region": code, "groupBy": "product"})
    return DrilldownResult(params=current)


def summary_intent() -> IntentDefinition:
    """Build a quarterly_summary-equivalent Intent for tests (the template path + drilldown)."""
    return define_intent(
        IntentSpec(
            canonical="sales.quarterly_summary",
            description="Quarterly summary description",
            viewLabel="Quarterly summary",
            source="sales",
            params=object_schema(
                {
                    "fiscalYear": number(integer=True, minimum=2025, maximum=2026).default(2026),
                    "quarter": number(integer=True, minimum=1, maximum=4).default(3),
                    "groupBy": group_by.enum().default("region"),
                    "region": region.enum().optional(),
                }
            ),
            examples=["this quarter's sales by region"],
            facets=[
                FacetSpec(param="fiscalYear", label="Fiscal year", options=[{"value": "2026", "label": "FY2026"}]),
                FacetSpec(param="groupBy", label="Group by", options=group_by),
                FacetSpec(param="region", label="Region", options=region, emptyLabel="All regions"),
            ],
            queries=[
                QueryTemplate(
                    path="summary",
                    paramMap={"fiscalYear": "fy", "quarter": "q", "groupBy": "groupBy", "region": "region"},
                )
            ],
            drilldown=_summary_drilldown,
        )
    )


class TestToIntentDef:
    def test_returns_intent_def_shape(self) -> None:
        def_ = summary_intent().to_intent_def()
        assert def_.name == "sales.quarterly_summary"
        assert def_.description == "Quarterly summary description"
        assert def_.examples == ["this quarter's sales by region"]
        assert callable(def_.to_queries)
        assert def_.drilldown is not None

    def test_no_drilldown_is_none(self) -> None:
        # Corresponds to TS's `"drilldown" in def === false` (in Python the attribute is None).
        def_ = define_intent(
            IntentSpec(
                canonical="x.y",
                description="d",
                source="sales",
                params=object_schema({"a": string().optional()}),
                examples=[],
                queries=[QueryTemplate(path="p", paramMap={"a": "a"})],
            )
        ).to_intent_def()
        assert def_.drilldown is None


class TestToQueries:
    def test_expands_param_map_and_drops_missing(self) -> None:
        def_ = summary_intent().to_intent_def()
        uris = [q.uri for q in def_.to_queries({"fiscalYear": 2026, "quarter": 3, "groupBy": "region"})]
        # region missing → excluded. Keys are sorted.
        assert uris == ["query://sales/summary?fy=2026&groupBy=region&q=3"]

    def test_fixed_params_always_added(self) -> None:
        def_ = define_intent(
            IntentSpec(
                canonical="sales.by_product",
                description="d",
                source="sales",
                params=object_schema(
                    {"fiscalYear": number().default(2026), "topN": number().default(5)}
                ),
                examples=[],
                queries=[
                    QueryTemplate(
                        path="summary",
                        paramMap={"fiscalYear": "fy", "topN": "topN"},
                        fixedParams={"groupBy": "product"},
                    )
                ],
            )
        ).to_intent_def()
        assert def_.to_queries({"fiscalYear": 2026, "topN": 5})[0].uri == (
            "query://sales/summary?fy=2026&groupBy=product&topN=5"
        )

    def test_template_array_maps_one_to_one(self) -> None:
        def_ = define_intent(
            IntentSpec(
                canonical="sales.target_attainment",
                description="d",
                source="sales",
                params=object_schema(
                    {"fiscalYear": number().default(2026), "quarter": number().default(2)}
                ),
                examples=[],
                queries=[
                    QueryTemplate(path="targets", paramMap={"fiscalYear": "fy", "quarter": "q"}),
                    QueryTemplate(
                        path="kpi",
                        paramMap={"fiscalYear": "fy", "quarter": "q"},
                        fixedParams={"metric": "target_attainment"},
                    ),
                ],
            )
        ).to_intent_def()
        assert [q.uri for q in def_.to_queries({"fiscalYear": 2026, "quarter": 2})] == [
            "query://sales/targets?fy=2026&q=2",
            "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
        ]

    def test_callback_escape_hatch(self) -> None:
        def _queries(p: JsonObject) -> list[QueryHandle]:
            fy = p["fiscalYear"]
            return [
                QueryHandle(uri=f"query://sales/kpi?fy={fy}&metric=total_revenue"),
                QueryHandle(uri=f"query://sales/kpi?fy={fy}&metric=yoy"),
            ]

        def_ = define_intent(
            IntentSpec(
                canonical="sales.kpi_overview",
                description="d",
                params=object_schema({"fiscalYear": number().default(2026)}),
                examples=[],
                queries=_queries,
            )
        ).to_intent_def()
        assert [q.uri for q in def_.to_queries({"fiscalYear": 2026})] == [
            "query://sales/kpi?fy=2026&metric=total_revenue",
            "query://sales/kpi?fy=2026&metric=yoy",
        ]

    def test_template_without_source_raises_at_definition(self) -> None:
        with pytest.raises(ValueError):
            define_intent(
                IntentSpec(
                    canonical="x",
                    description="d",
                    params=object_schema({"a": string().optional()}),
                    examples=[],
                    queries=[QueryTemplate(path="p", paramMap={"a": "a"})],
                )
            )


class TestDrilldown:
    def test_region_row_click_drills_to_product(self) -> None:
        def_ = summary_intent().to_intent_def()
        assert def_.drilldown is not None
        out = def_.drilldown(
            {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"}, {"drilldown": "Japan"}
        )
        assert out.params == {
            "fiscalYear": 2026,
            "quarter": 3,
            "groupBy": "product",
            "region": "japan",
        }

    def test_non_region_group_by_is_unchanged(self) -> None:
        def_ = summary_intent().to_intent_def()
        assert def_.drilldown is not None
        current: JsonObject = {"fiscalYear": 2026, "quarter": 3, "groupBy": "product"}
        assert def_.drilldown(current, {"drilldown": "Japan"}).params == current


class TestToFacetView:
    def test_derives_entries(self) -> None:
        view = summary_intent().to_facet_view()
        assert view.intent == "sales.quarterly_summary"
        assert view.label == "Quarterly summary"  # viewLabel takes precedence
        assert view.to_wire()["facets"] == [
            {
                "key": "fiscalYear",
                "label": "Fiscal year",
                "control": "select",
                "valueType": "number",
                "options": [{"value": "2026", "label": "FY2026"}],
            },
            {
                "key": "groupBy",
                "label": "Group by",
                "control": "select",
                "valueType": "string",
                "options": [
                    {"value": "region", "label": "By region"},
                    {"value": "product", "label": "By product"},
                    {"value": "channel", "label": "By channel"},
                ],
            },
            {
                "key": "region",
                "label": "Region",
                "control": "select",
                "valueType": "string",
                "options": [
                    {"value": "japan", "label": "Japan"},
                    {"value": "north_america", "label": "North America"},
                    {"value": "europe", "label": "Europe"},
                    {"value": "apac", "label": "APAC"},
                ],
                "allowEmpty": "All regions",
            },
        ]

    def test_view_label_falls_back_to_description(self) -> None:
        view = define_intent(
            IntentSpec(
                canonical="x.y",
                description="Description label",
                source="sales",
                params=object_schema({"a": region.enum().optional()}),
                examples=[],
                facets=[FacetSpec(param="a", label="A")],
                queries=[QueryTemplate(path="p", paramMap={"a": "a"})],
            )
        ).to_facet_view()
        assert view.label == "Description label"

    def test_options_omitted_derives_from_enum(self) -> None:
        view = define_intent(
            IntentSpec(
                canonical="x.y",
                description="d",
                source="sales",
                params=object_schema({"a": region.enum().optional()}),
                examples=[],
                facets=[FacetSpec(param="a", label="A")],
                queries=[QueryTemplate(path="p", paramMap={"a": "a"})],
            )
        ).to_facet_view()
        assert view.facets[0].options == [
            {"value": "japan", "label": "japan"},
            {"value": "north_america", "label": "north_america"},
            {"value": "europe", "label": "europe"},
            {"value": "apac", "label": "apac"},
        ]

    def test_order_and_control_respected(self) -> None:
        view = define_intent(
            IntentSpec(
                canonical="x.y",
                description="d",
                source="sales",
                params=object_schema({"a": string().optional(), "b": string().optional()}),
                examples=[],
                facets=[
                    FacetSpec(param="a", label="A", order=2, options=[{"value": "1", "label": "one"}]),
                    FacetSpec(
                        param="b", label="B", order=1, control="radio", options=[{"value": "2", "label": "two"}]
                    ),
                ],
                queries=[QueryTemplate(path="p")],
            )
        ).to_facet_view()
        assert [f.key for f in view.facets] == ["b", "a"]
        assert view.facets[0].control == "radio"

    def test_unknown_facet_param_raises(self) -> None:
        with pytest.raises(ValueError):
            define_intent(
                IntentSpec(
                    canonical="x.y",
                    description="d",
                    source="sales",
                    params=object_schema({"a": string().optional()}),
                    examples=[],
                    facets=[FacetSpec(param="missing", label="M", options=[{"value": "1", "label": "one"}])],
                    queries=[QueryTemplate(path="p")],
                )
            ).to_facet_view()


class TestValueTypeDerivation:
    def test_coerce_number_is_number(self) -> None:
        view = define_intent(
            IntentSpec(
                canonical="x.y",
                description="d",
                source="sales",
                params=object_schema(
                    {
                        "n1": number(integer=True, minimum=1, maximum=20).default(5),
                        "n2": number(integer=True).optional(),
                    }
                ),
                examples=[],
                facets=[
                    FacetSpec(param="n1", label="N1", options=[{"value": "5", "label": "5"}]),
                    FacetSpec(param="n2", label="N2", options=[{"value": "1", "label": "1"}]),
                ],
                queries=[QueryTemplate(path="p")],
            )
        ).to_facet_view()
        assert [f.valueType for f in view.facets] == ["number", "number"]

    def test_enum_and_string_are_string(self) -> None:
        view = define_intent(
            IntentSpec(
                canonical="x.y",
                description="d",
                source="sales",
                params=object_schema({"e": region.enum().optional(), "s": string().optional()}),
                examples=[],
                facets=[
                    FacetSpec(param="e", label="E", options=region),
                    FacetSpec(param="s", label="S", options=[{"value": "x", "label": "x"}]),
                ],
                queries=[QueryTemplate(path="p")],
            )
        ).to_facet_view()
        assert [f.valueType for f in view.facets] == ["string", "string"]


class TestToolSourceAndParseParams:
    def test_to_tool_source(self) -> None:
        src = summary_intent().to_tool_source()
        assert src.name == "sales.quarterly_summary"
        assert src.description == "Quarterly summary description"
        assert src.params.safe_parse({"fiscalYear": "2026"}).success is True

    def test_parse_params_coerces_and_fills_defaults(self) -> None:
        parsed = summary_intent().parse_params({"fiscalYear": "2026", "quarter": "3"})
        # string → number coerce, groupBy is default-filled, region (optional) is dropped.
        assert parsed == {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"}


class TestFacetViewLocaleOverlays:
    """Mirrors TS intent.test.ts "carries locale overlays … into the view"."""

    def _view(self) -> FacetView:
        bilingual_region = define_vocabulary(
            "region", {"japan": {"en": "Japan", "ja": "日本"}, "europe": "Europe"}
        )
        return define_intent(
            IntentSpec(
                canonical="x.y",
                description="d",
                viewLabel="Quarterly summary",
                viewLabels={"ja": "四半期サマリー"},
                source="sales",
                params=object_schema(
                    {
                        "region": bilingual_region.enum().optional(),
                        "fiscalYear": number(integer=True).default(2026),
                    }
                ),
                examples=[],
                facets=[
                    FacetSpec(
                        param="region",
                        label="Region",
                        labels={"ja": "地域"},
                        options=bilingual_region,
                        emptyLabel="All regions",
                        emptyLabels={"ja": "すべての地域"},
                    ),
                    FacetSpec(
                        param="fiscalYear",
                        label="Fiscal year",
                        options=[{"value": "2026", "label": "FY2026", "labels": {"ja": "2026年度"}}],
                    ),
                ],
                queries=[QueryTemplate(path="p")],
            )
        ).to_facet_view()

    def test_overlays_are_carried_into_the_view(self) -> None:
        view = self._view()
        assert view.labels == {"ja": "四半期サマリー"}
        facet = view.facets[0]
        assert facet.labels == {"ja": "地域"}
        assert facet.allowEmpty == "All regions"
        assert facet.allowEmptyLabels == {"ja": "すべての地域"}
        assert facet.options == [
            {"value": "japan", "label": "Japan", "labels": {"ja": "日本"}},
            {"value": "europe", "label": "Europe"},
        ]
        assert view.facets[1].options == [
            {"value": "2026", "label": "FY2026", "labels": {"ja": "2026年度"}}
        ]

    def test_to_wire_emits_overlays_only_when_declared(self) -> None:
        wire = self._view().to_wire()
        assert wire["labels"] == {"ja": "四半期サマリー"}
        assert wire["facets"][0]["allowEmptyLabels"] == {"ja": "すべての地域"}
        # The plain summary intent (no overlays) emits no overlay keys.
        plain = summary_intent().to_facet_view().to_wire()
        assert "labels" not in plain
        for facet in plain["facets"]:
            assert "labels" not in facet
            assert "allowEmptyLabels" not in facet

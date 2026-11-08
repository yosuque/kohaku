"""Tests for IntentDef.filters (the same scenarios as TS packages/intents/test/filters.test.ts)."""

from __future__ import annotations

from kohaku.intents import (
    EnumField,
    FacetSpec,
    IntentDefinition,
    IntentSpec,
    QueryTemplate,
    define_intent,
    define_vocabulary,
    number,
    object_schema,
)
from kohaku.spec import FilterDescriptor, FilterOption, JsonObject, QueryHandle

region = define_vocabulary(
    "region",
    {"japan": {"en": "Japan", "ja": "日本"}, "europe": "Europe", "apac": "APAC"},
)
group_by = define_vocabulary("groupBy", {"region": "By region", "product": "By product"})


def _summary(facets: list[FacetSpec] | None = None) -> IntentDefinition:
    return define_intent(
        IntentSpec(
            canonical="sales.summary",
            description="Summary",
            source="sales",
            params=object_schema(
                {
                    "fiscalYear": number(integer=True, minimum=2025, maximum=2026).default(2026),
                    "groupBy": group_by.enum().default("region"),
                    "region": region.enum().optional(),
                    "metric": EnumField(values=("revenue", "units")).default("revenue"),
                }
            ),
            examples=[],
            facets=facets
            if facets is not None
            else [
                FacetSpec(
                    param="fiscalYear",
                    label="Fiscal year",
                    options=[{"value": "2026", "label": "FY2026"}],
                ),
                FacetSpec(
                    param="groupBy", label="Group by", labels={"ja": "集計軸"}, options=group_by
                ),
                FacetSpec(param="region", label="Region", options=region, emptyLabel="All regions"),
                FacetSpec(param="metric", label="Metric"),
            ],
            queries=[
                QueryTemplate(
                    path="summary",
                    paramMap={
                        "fiscalYear": "fy",
                        "groupBy": "groupBy",
                        "region": "geo",
                        "metric": "m",
                    },
                )
            ],
        )
    )


def test_derives_a_descriptor_per_string_select_facet_mapping_query_param_through_param_map() -> (
    None
):
    definition = _summary()
    filters = definition.to_intent_def().filters
    assert filters is not None
    assert filters() == [
        FilterDescriptor(
            param="groupBy",
            queryParam="groupBy",
            paths=["summary"],
            label="Group by",
            options=[FilterOption("region", "By region"), FilterOption("product", "By product")],
        ),
        FilterDescriptor(
            param="region",
            queryParam="geo",
            paths=["summary"],
            label="Region",
            options=[
                FilterOption("japan", "Japan"),
                FilterOption("europe", "Europe"),
                FilterOption("apac", "APAC"),
            ],
        ),
        # `metric` has no options declaration: derived from the param's enum (label reuses value).
        FilterDescriptor(
            param="metric",
            queryParam="m",
            paths=["summary"],
            label="Metric",
            options=[FilterOption("revenue", "revenue"), FilterOption("units", "units")],
        ),
    ]


def test_excludes_numeric_param_and_control_number_facets() -> None:
    definition = _summary(
        [
            FacetSpec(
                param="fiscalYear",
                label="Fiscal year",
                options=[{"value": "2026", "label": "FY2026"}],
            ),
            FacetSpec(param="groupBy", label="Group by", control="number", options=group_by),
        ]
    )
    filters = definition.to_intent_def().filters
    assert filters is not None
    assert filters() == []


def test_applies_the_locale_overlay_to_facet_and_option_labels_falling_back_to_canonical() -> None:
    filters = _summary().to_intent_def().filters
    assert filters is not None
    out = {f.param: f for f in filters("ja")}
    assert out["groupBy"].label == "集計軸"
    assert out["region"].label == "Region"
    assert out["region"].options[0] == FilterOption("japan", "日本")
    assert out["region"].options[1] == FilterOption("europe", "Europe")


def test_skips_ambiguous_and_unmapped_params() -> None:
    definition = define_intent(
        IntentSpec(
            canonical="sales.two",
            description="Two queries",
            source="sales",
            params=object_schema(
                {"groupBy": group_by.enum().default("region"), "region": region.enum().optional()}
            ),
            examples=[],
            facets=[
                FacetSpec(param="groupBy", label="Group by", options=group_by),
                FacetSpec(param="region", label="Region", options=region),
            ],
            queries=[
                QueryTemplate(path="a", paramMap={"groupBy": "g1"}),
                QueryTemplate(path="b", paramMap={"groupBy": "g2"}),
            ],
        )
    )
    filters = definition.to_intent_def().filters
    assert filters is not None
    # groupBy maps to g1 and g2 (ambiguous); region is in no paramMap at all.
    assert filters() == []


def test_absent_when_queries_is_a_callback() -> None:
    def queries(p: JsonObject) -> list[QueryHandle]:
        return [QueryHandle(uri=f"query://sales/x?g={p['groupBy']}")]

    definition = define_intent(
        IntentSpec(
            canonical="sales.callback",
            description="Callback",
            params=object_schema({"groupBy": group_by.enum().default("region")}),
            examples=[],
            facets=[FacetSpec(param="groupBy", label="Group by", options=group_by)],
            queries=queries,
        )
    )
    assert definition.to_intent_def().filters is None


def test_does_not_change_to_facet_view_output() -> None:
    view = _summary().to_facet_view()
    assert [f.key for f in view.facets] == ["fiscalYear", "groupBy", "region", "metric"]


def test_falls_back_from_a_regional_tag_to_its_primary_subtag_then_to_canonical() -> None:
    filters = _summary().to_intent_def().filters
    assert filters is not None
    jp = {f.param: f for f in filters("ja-JP")}
    assert jp["groupBy"].label == "集計軸"
    assert jp["region"].options[0] == FilterOption("japan", "日本")
    fr = {f.param: f for f in filters("fr-CA")}
    assert fr["groupBy"].label == "Group by"


def test_collects_every_template_path_and_excludes_filters_whose_query_param_is_fixed_or_shared() -> (
    None
):
    definition = define_intent(
        IntentSpec(
            canonical="sales.paths",
            description="Paths",
            source="sales",
            params=object_schema(
                {
                    "groupBy": group_by.enum().default("region"),
                    "region": region.enum().optional(),
                    "other": EnumField(values=("a", "b")).default("a"),
                    "fixedClash": EnumField(values=("x", "y")).default("x"),
                }
            ),
            examples=[],
            facets=[
                FacetSpec(param="groupBy", label="Group by", options=group_by),
                FacetSpec(param="region", label="Region", options=region),
                FacetSpec(param="other", label="Other"),
                FacetSpec(param="fixedClash", label="Fixed clash"),
            ],
            queries=[
                QueryTemplate(path="a", paramMap={"groupBy": "g", "region": "geo", "other": "geo"}),
                QueryTemplate(
                    path="b", paramMap={"groupBy": "g"}, fixedParams={"mode": "full", "clash": "1"}
                ),
                QueryTemplate(path="c", paramMap={"fixedClash": "clash"}),
            ],
        )
    )
    filters = definition.to_intent_def().filters
    assert filters is not None
    # groupBy governs a and b; region/other both map "geo" on path a (two params, one queryParam => both
    # excluded); fixedClash's queryParam is a fixed parameter of path b (excluded).
    assert [(f.param, f.paths) for f in filters()] == [("groupBy", ["a", "b"])]


def test_a_facet_declared_not_filterable_is_skipped_but_stays_in_the_facet_view() -> None:
    facets = [
        FacetSpec(param="groupBy", label="Group by", options=group_by, filterable=False),
        FacetSpec(param="region", label="Region", options=region, emptyLabel="All regions"),
    ]
    definition = _summary(facets)
    filters = definition.to_intent_def().filters
    assert filters is not None
    assert [f.param for f in filters()] == ["region"]
    assert [f.key for f in definition.to_facet_view().facets] == ["groupBy", "region"]
    # filterable defaults to True, and an explicit True behaves the same.
    explicit = _summary(
        [
            FacetSpec(param="groupBy", label="Group by", options=group_by, filterable=True),
            FacetSpec(param="region", label="Region", options=region, emptyLabel="All regions"),
        ]
    )
    explicit_filters = explicit.to_intent_def().filters
    assert explicit_filters is not None
    assert [f.param for f in explicit_filters()] == ["groupBy", "region"]

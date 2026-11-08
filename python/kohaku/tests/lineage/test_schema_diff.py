"""diff_draft: field-level diff between the suggested draft and the human-submitted draft
(pytest port of packages/lineage/test/schema-diff.test.ts, plus the absent-versus-null cases).
"""

from __future__ import annotations

import dataclasses

from kohaku.lineage import ComponentDraft, QueryTemplate, diff_draft

SUGGESTED = ComponentDraft(
    componentType="sales.calendarHeatmap",
    version="1.0.0",
    intentName="sales.calendar_heatmap",
    description="Display sales as a monthly calendar heatmap",
    paramsJsonSchema={
        "type": "object",
        "properties": {"fiscalYear": {"type": "integer", "default": 2026}},
    },
    queryTemplate=QueryTemplate(
        path="trend",
        fixedParams={"metric": "revenue", "granularity": "month"},
        paramMap={"fiscalYear": "fy"},
    ),
)


def test_reports_every_field_as_unchanged_for_an_identical_draft() -> None:
    diff = diff_draft(SUGGESTED, dataclasses.replace(SUGGESTED))
    assert diff["changed"] == []
    assert diff["unchanged"] == [
        "componentType",
        "version",
        "intentName",
        "description",
        "paramsJsonSchema",
        "queryTemplate",
    ]


def test_ignores_json_key_order_when_comparing_object_fields() -> None:
    reordered = dataclasses.replace(
        SUGGESTED,
        queryTemplate=QueryTemplate(
            path="trend",
            paramMap={"fiscalYear": "fy"},
            fixedParams={"granularity": "month", "metric": "revenue"},
        ),
    )
    assert diff_draft(SUGGESTED, reordered)["changed"] == []


def test_lists_a_changed_field_with_both_values_in_the_fixed_field_order() -> None:
    edited = dataclasses.replace(SUGGESTED, description="Monthly sales heatmap", queryTemplate=None)
    diff = diff_draft(SUGGESTED, edited)
    # `final` is omitted for the queryTemplate that the reviewer removed (TS's `final: undefined`).
    assert diff["changed"] == [
        {
            "field": "description",
            "suggested": SUGGESTED.description,
            "final": "Monthly sales heatmap",
        },
        {"field": "queryTemplate", "suggested": SUGGESTED.queryTemplate.to_wire()},  # type: ignore[union-attr]
    ]
    assert diff["unchanged"] == ["componentType", "version", "intentName", "paramsJsonSchema"]


def test_treats_an_absent_optional_field_on_both_sides_as_unchanged() -> None:
    a = ComponentDraft(componentType="x.y", version="1.0.0", intentName="x.y", description="d")
    diff = diff_draft(a, dataclasses.replace(a))
    assert diff["changed"] == []
    assert "paramsJsonSchema" in diff["unchanged"]


def test_an_explicit_null_is_a_value_distinct_from_an_absent_key() -> None:
    # Wire dicts (a persisted suggestion) can carry an explicit JSON null; it compares as "null", not as absent.
    base = {"componentType": "x.y", "version": "1.0.0", "intentName": "x.y", "description": "d"}
    with_null = {**base, "paramsJsonSchema": None}
    diff = diff_draft(base, with_null)
    assert diff["changed"] == [{"field": "paramsJsonSchema", "final": None}]
    assert diff_draft(with_null, with_null)["changed"] == []
    assert diff_draft(with_null, base)["changed"] == [
        {"field": "paramsJsonSchema", "suggested": None}
    ]

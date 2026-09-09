"""Parity test for the Intent catalog (port of TS: apps/sample-api/test/intent-parity.test.ts).

The expected values bake in goldens machine-collected from before the TS migration (hand-written IntentDef).
Pins that normalize_params (coerce + default filling) / to_queries (canonical URI) / drilldown do not differ from TS
by a single byte, using representative inputs (NL-origin, GUI-origin strings, drilldown, boundary values, default filling).
"""

from __future__ import annotations

import pytest

from kohaku.spec import JsonObject
from sales_api.intents_catalog import INTENT_DEFS, IntentCatalog

catalog = IntentCatalog()


def _def_of(name: str) -> object:
    for d in INTENT_DEFS:
        if d.name == name:
            return d
    raise AssertionError(f"intent not found: {name}")


# (intent, input, normalized, queries)
NORM_CASES: list[tuple[str, JsonObject, JsonObject, list[str]]] = [
    (
        "sales.quarterly_summary",
        {},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
        ["query://sales/summary?fy=2026&groupBy=region&q=3"],
    ),
    (
        "sales.quarterly_summary",
        {"fiscalYear": "2026", "quarter": "3", "groupBy": "region"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
        ["query://sales/summary?fy=2026&groupBy=region&q=3"],
    ),
    (
        "sales.quarterly_summary",
        {"fiscalYear": "2025", "quarter": "1", "groupBy": "product", "region": "japan"},
        {"fiscalYear": 2025, "quarter": 1, "groupBy": "product", "region": "japan"},
        ["query://sales/summary?fy=2025&groupBy=product&q=1&region=japan"],
    ),
    (
        "sales.quarterly_summary",
        {"groupBy": "channel"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "channel"},
        ["query://sales/summary?fy=2026&groupBy=channel&q=3"],
    ),
    (
        "sales.quarterly_summary",
        {"quarter": "4", "fiscalYear": "2025"},
        {"fiscalYear": 2025, "quarter": 4, "groupBy": "region"},
        ["query://sales/summary?fy=2025&groupBy=region&q=4"],
    ),
    (
        "sales.trend",
        {},
        {"metric": "revenue", "granularity": "month"},
        ["query://sales/trend?granularity=month&metric=revenue"],
    ),
    (
        "sales.trend",
        {"metric": "units", "granularity": "quarter", "region": "apac"},
        {"region": "apac", "metric": "units", "granularity": "quarter"},
        ["query://sales/trend?granularity=quarter&metric=units&region=apac"],
    ),
    (
        "sales.trend",
        {"fiscalYear": "2026", "productId": "p-1"},
        {"fiscalYear": 2026, "productId": "p-1", "metric": "revenue", "granularity": "month"},
        ["query://sales/trend?fy=2026&granularity=month&metric=revenue&productId=p-1"],
    ),
    (
        "sales.by_product",
        {},
        {"fiscalYear": 2026, "metric": "revenue", "topN": 5},
        ["query://sales/summary?fy=2026&groupBy=product&topN=5"],
    ),
    (
        "sales.by_product",
        {"topN": "10", "region": "japan", "quarter": "2"},
        {"fiscalYear": 2026, "quarter": 2, "region": "japan", "metric": "revenue", "topN": 10},
        ["query://sales/summary?fy=2026&groupBy=product&q=2&region=japan&topN=10"],
    ),
    (
        "sales.by_product",
        {"topN": "3"},
        {"fiscalYear": 2026, "metric": "revenue", "topN": 3},
        ["query://sales/summary?fy=2026&groupBy=product&topN=3"],
    ),
    (
        "sales.kpi_overview",
        {},
        {"fiscalYear": 2026},
        [
            "query://sales/kpi?fy=2026&metric=total_revenue",
            "query://sales/kpi?fy=2026&metric=yoy",
            "query://sales/kpi?fy=2026&metric=top_region",
            "query://sales/kpi?fy=2026&metric=target_attainment",
        ],
    ),
    (
        "sales.kpi_overview",
        {"fiscalYear": "2025", "quarter": "4"},
        {"fiscalYear": 2025, "quarter": 4},
        [
            "query://sales/kpi?fy=2025&metric=total_revenue&q=4",
            "query://sales/kpi?fy=2025&metric=yoy&q=4",
            "query://sales/kpi?fy=2025&metric=top_region&q=4",
            "query://sales/kpi?fy=2025&metric=target_attainment&q=4",
        ],
    ),
    (
        "sales.records",
        {},
        {"limit": 100},
        ["query://sales/records?limit=100"],
    ),
    (
        "sales.records",
        {"region": "europe", "channel": "partner", "limit": "50", "quarter": "2"},
        {"quarter": 2, "region": "europe", "channel": "partner", "limit": 50},
        ["query://sales/records?channel=partner&limit=50&q=2&region=europe"],
    ),
    (
        "sales.records",
        {"productId": "p-2", "fiscalYear": "2025"},
        {"fiscalYear": 2025, "productId": "p-2", "limit": 100},
        ["query://sales/records?fy=2025&limit=100&productId=p-2"],
    ),
    (
        "sales.target_attainment",
        {},
        {"fiscalYear": 2026, "quarter": 2},
        [
            "query://sales/targets?fy=2026&q=2",
            "query://sales/kpi?fy=2026&metric=target_attainment&q=2",
        ],
    ),
    (
        "sales.target_attainment",
        {"fiscalYear": "2025", "quarter": "3"},
        {"fiscalYear": 2025, "quarter": 3},
        [
            "query://sales/targets?fy=2025&q=3",
            "query://sales/kpi?fy=2025&metric=target_attainment&q=3",
        ],
    ),
    (
        "sales.custom",
        {"request": "売上をヒートマップで"},
        {"request": "売上をヒートマップで"},
        ["query://sales/trend?fy=2026&granularity=month&metric=revenue"],
    ),
    (
        "sales.custom",
        {"request": "x", "baseIntent": "sales.trend"},
        {"request": "x", "baseIntent": "sales.trend"},
        ["query://sales/trend?fy=2026&granularity=month&metric=revenue"],
    ),
]


@pytest.mark.parametrize(("intent", "input_", "normalized", "queries"), NORM_CASES)
def test_normalize_params_parity(
    intent: str, input_: JsonObject, normalized: JsonObject, queries: list[str]
) -> None:
    assert catalog.normalize_params(intent, input_) == normalized


@pytest.mark.parametrize(("intent", "input_", "normalized", "queries"), NORM_CASES)
def test_to_queries_parity(
    intent: str, input_: JsonObject, normalized: JsonObject, queries: list[str]
) -> None:
    norm = catalog.normalize_params(intent, input_)
    assert norm is not None
    def_ = _def_of(intent)
    uris = [q.uri for q in def_.to_queries(norm)]  # type: ignore[attr-defined]
    assert uris == queries


# (intent, current, payload, drilldown_params, normalized)
DRILL_CASES: list[tuple[str, JsonObject, JsonObject, JsonObject, JsonObject]] = [
    (
        "sales.quarterly_summary",
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
        {"drilldown": "Japan"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "product", "region": "japan"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "product", "region": "japan"},
    ),
    (
        "sales.quarterly_summary",
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
        {"drilldown": "apac"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "product", "region": "apac"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "product", "region": "apac"},
    ),
    (
        "sales.quarterly_summary",
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "product"},
        {"drilldown": "Japan"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "product"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "product"},
    ),
    (
        "sales.quarterly_summary",
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
        {"drilldown": ""},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
        {"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
    ),
]


@pytest.mark.parametrize(("intent", "current", "payload", "drill_params", "normalized"), DRILL_CASES)
def test_drilldown_parity(
    intent: str,
    current: JsonObject,
    payload: JsonObject,
    drill_params: JsonObject,
    normalized: JsonObject,
) -> None:
    def_ = _def_of(intent)
    out = def_.drilldown(current, payload)  # type: ignore[attr-defined]
    assert out.params == drill_params
    canonical = out.canonical if out.canonical is not None else intent
    assert catalog.normalize_params(canonical, out.params) == normalized


class TestByProductMetricPropagation:
    """metric propagation of sales.by_product (default-value omission)."""

    def test_units_propagates(self) -> None:
        norm = catalog.normalize_params("sales.by_product", {"metric": "units"})
        assert norm == {"fiscalYear": 2026, "metric": "units", "topN": 5}
        def_ = _def_of("sales.by_product")
        uris = [q.uri for q in def_.to_queries(norm)]  # type: ignore[attr-defined]
        assert uris == ["query://sales/summary?fy=2026&groupBy=product&metric=units&topN=5"]

    def test_default_revenue_omitted(self) -> None:
        norm = catalog.normalize_params("sales.by_product", {"metric": "revenue", "quarter": "2"})
        assert norm == {"fiscalYear": 2026, "quarter": 2, "metric": "revenue", "topN": 5}
        def_ = _def_of("sales.by_product")
        uris = [q.uri for q in def_.to_queries(norm)]  # type: ignore[attr-defined]
        assert uris == ["query://sales/summary?fy=2026&groupBy=product&q=2&topN=5"]


class TestExamplePlacement:
    """Placement of example sentences (preventing mis-routing to a quarter-required Intent)."""

    def test_this_quarter_by_product_example(self) -> None:
        by_product = _def_of("sales.by_product")
        quarterly = _def_of("sales.quarterly_summary")
        assert "今期の製品別売上は?" in by_product.examples  # type: ignore[attr-defined]
        assert "今期の製品別売上は?" not in quarterly.examples  # type: ignore[attr-defined]

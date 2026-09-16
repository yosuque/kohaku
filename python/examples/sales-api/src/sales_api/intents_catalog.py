"""Intent catalog and vocabulary (port of TS: apps/sample-api/src/intents/{vocab,catalog}.ts).

- vocab.ts: the single source of value sets + display labels (define_vocabulary) and the shared schema fragments for fiscal year/quarter
- catalog.ts: the single definitions (define_intent) of the normalized Intents this sample supports + IntentCatalog

From a single define_intent, the IntentDef for SemanticPort (to_intent_def), the GUI facet descriptor, and the MCP
source are derived. IntentDef is single-defined in @kohaku-ui/intents; here it is re-exported as the product boundary.
"""

from __future__ import annotations

from typing import Any

from kohaku.data_binding import format_query_ref
from kohaku.intents import (
    DrilldownResult,
    FacetSpec,
    IntentDef,
    IntentDefinition,
    IntentSpec,
    QueryTemplate,
    Vocabulary,
    VocabularyEntry,
    define_intent,
    define_vocabulary,
    number,
    object_schema,
    string,
)
from kohaku.spec import JsonObject, JsonValue, QueryHandle, js_string

from .domain import CHANNEL_LABELS, DEMO_FISCAL_YEAR, REGION_LABELS

# --- vocab.ts: vocabulary (value sets + display labels) and shared schema fragments ---


def _bilingual(en: dict[str, str], ja: dict[str, str]) -> dict[str, VocabularyEntry]:
    """Merges the canonical (English) label map with a same-key JA map into bilingual entries."""
    return {code: {"en": label, "ja": ja[code]} for code, label in en.items()}


# region / channel use domain's *_LABELS as the single source (canonical English); the JA overlays
# declared here make the vocabulary the single source for both languages (fixed specs, facet views,
# and drilldown reverse-lookup all draw from it). Mirrors TS sample-api's vocab.ts.
region: Vocabulary = define_vocabulary(
    "region",
    _bilingual(REGION_LABELS, {"japan": "日本", "north_america": "北米", "europe": "欧州", "apac": "APAC"}),
)
channel: Vocabulary = define_vocabulary(
    "channel",
    _bilingual(CHANNEL_LABELS, {"direct": "直販", "partner": "パートナー", "online": "オンライン"}),
)

# The metric (revenue / units). The enum for the GUI "metric" facet and NL normalization.
metric: Vocabulary = define_vocabulary(
    "metric",
    {"revenue": {"en": "Revenue", "ja": "売上"}, "units": {"en": "Units", "ja": "販売数"}},
)

# The aggregation axis. Matched to the facet's aggregation-axis label.
group_by: Vocabulary = define_vocabulary(
    "groupBy",
    {
        "region": {"en": "By region", "ja": "地域別"},
        "product": {"en": "By product", "ja": "製品別"},
        "channel": {"en": "By channel", "ja": "チャネル別"},
    },
)

# The granularity of the time series (monthly / quarterly).
granularity: Vocabulary = define_vocabulary(
    "granularity",
    {"month": {"en": "Monthly", "ja": "月次"}, "quarter": {"en": "Quarterly", "ja": "四半期"}},
)

# The single source of the fiscal-year value range (FY2025 to FY2026). Kept consistent with the range the seed
# (which generates 2 fiscal years' worth time-independently) holds. Both the min/max of the fiscal_year fragment and
# the fiscal-year clamp of NL normalization (semantic_port) use this.
FISCAL_YEAR_MIN = 2025
FISCAL_YEAR_MAX = 2026

# Fiscal year (FY2025 to FY2026) / quarter (1 to 4). Shared Zod fragments that accept GUI-origin strings via coerce.
# NumberField is frozen and .default()/.optional() return new instances, so the module constants can be safely reused.
fiscal_year = number(integer=True, minimum=FISCAL_YEAR_MIN, maximum=FISCAL_YEAR_MAX)
quarter = number(integer=True, minimum=1, maximum=4)

# The demo "current period" defaults (TS: vocab.ts DEMO_FISCAL_YEAR / DEMO_QUARTER_SUMMARY /
# DEMO_QUARTER_ATTAINMENT), single-sourced instead of scattered as literals across this module and domain.py.
# DEMO_FISCAL_YEAR itself is defined in domain.py (imported above) rather than here: this module already imports
# domain.py for the region/channel labels, and domain.py's kpi()/targets() also need the fiscal-year default, so
# defining it here and importing it back into domain.py would be a circular import. It is kept equal to
# FISCAL_YEAR_MAX (2026) by convention. The quarter defaults have no such constraint (domain.py never needs them),
# so they are single-sourced here as usual.
assert DEMO_FISCAL_YEAR == FISCAL_YEAR_MAX, "DEMO_FISCAL_YEAR (domain.py) must track FISCAL_YEAR_MAX"
# sales.quarterly_summary and sales.target_attainment intentionally default to different quarters. Both quarters
# have complete records and targets in the seed for every fiscal year (no data-completeness reason for the
# split); the difference is a demo choice — each intent's default quarter matches the quarter used in its own
# example questions — kept as-is for cache/golden stability.
DEMO_QUARTER_SUMMARY = 3
DEMO_QUARTER_ATTAINMENT = 2


# --- catalog.ts ---

_SOURCE = "sales"


def _ref(path: str, params: dict[str, JsonValue]) -> QueryHandle:
    """A query-ref helper for the callback escape hatch of by_product / kpi_overview / custom (source=sales fixed).

    Equivalent to TS's `Object.entries().filter(v != null && v !== "").map([k, String(v)])`.
    """
    cleaned = {k: js_string(v) for k, v in params.items() if v is not None and v != ""}
    return QueryHandle(uri=format_query_ref(source=_SOURCE, path=path, params=cleaned))


# Curated facet options for numeric ranges (fiscal year / quarter; a display curation rather than a value set).
_FY_OPTIONS: list[dict[str, Any]] = [
    {"value": "2025", "label": "FY2025", "labels": {"ja": "2025年度"}},
    {"value": "2026", "label": "FY2026", "labels": {"ja": "2026年度"}},
]
# Q1-Q4 read the same in both languages — no overlay.
_QUARTER_OPTIONS = [{"value": str(q), "label": f"Q{q}"} for q in (1, 2, 3, 4)]

# Shared facet-label overlays (the same facet keys repeat across intents).
_JA_FISCAL_YEAR = {"ja": "会計年度"}
_JA_QUARTER = {"ja": "四半期"}
_JA_REGION = {"ja": "地域"}
_JA_ALL_REGIONS = {"ja": "すべての地域"}
_JA_ALL_PERIODS = {"ja": "全期間"}
_JA_FULL_YEAR = {"ja": "通年"}


def _summary_drilldown(current: JsonObject, payload: JsonObject) -> DrilldownResult:
    # Click on an aggregation row -> narrow to that region and drill down to per-product. The row's display value is a
    # display label, so whether a label or a code arrives, it is normalized to a region code
    # (reverse_label reverse-looks-up display label -> code).
    raw = payload.get("drilldown")
    clicked = "" if raw is None else js_string(raw)
    region_code = region.reverse_label(clicked)
    code = clicked if region_code is None else region_code
    if current.get("groupBy") == "region" and code != "":
        return DrilldownResult(params={**current, "region": code, "groupBy": "product"})
    return DrilldownResult(params=current)


def _by_product_queries(p: JsonObject) -> list[QueryHandle]:
    # Propagate metric to summary (the basis for sorting and topN slicing). When the default "revenue", metric is
    # omitted so as not to change the existing canonical URI / cache key / golden (default-value omission).
    return [
        _ref(
            "summary",
            {
                "fy": p.get("fiscalYear"),
                "q": p.get("quarter"),
                "region": p.get("region"),
                "topN": p.get("topN"),
                "groupBy": "product",
                "metric": "units" if p.get("metric") == "units" else None,
            },
        )
    ]


def _kpi_overview_queries(p: JsonObject) -> list[QueryHandle]:
    # 1 intent -> 4 queries (swapping metric) keeps the legacy logic via the callback escape hatch.
    base: dict[str, JsonValue] = {"fy": p.get("fiscalYear"), "q": p.get("quarter")}
    return [
        _ref("kpi", {**base, "metric": "total_revenue"}),
        _ref("kpi", {**base, "metric": "yoy"}),
        _ref("kpi", {**base, "metric": "top_region"}),
        _ref("kpi", {**base, "metric": "target_attainment"}),
    ]


def _custom_queries(_p: JsonObject) -> list[QueryHandle]:
    # The primary data of the L2 widget: monthly trend (the most general-purpose material for free-form visualization).
    return [_ref("trend", {"fy": DEMO_FISCAL_YEAR, "metric": "revenue", "granularity": "month"})]


INTENT_DEFINITIONS: list[IntentDefinition] = [
    define_intent(
        IntentSpec(
            canonical="sales.quarterly_summary",
            description="Aggregate the sales for the given quarter by region/product/channel",
            source=_SOURCE,
            viewLabel="Quarterly Summary",
            viewLabels={"ja": "四半期サマリー"},
            params=object_schema(
                {
                    "fiscalYear": fiscal_year.default(DEMO_FISCAL_YEAR),
                    "quarter": quarter.default(DEMO_QUARTER_SUMMARY),
                    "groupBy": group_by.enum().default("region"),
                    "region": region.enum().optional(),
                }
            ),
            # Examples are bilingual: English (default demo) plus the Japanese originals (multilingual NL demo).
            examples=[
                "FY2026 Q3 sales by region as a chart",
                "Q2 actuals by channel",
                "2026年度Q3の地域別売上をグラフで",
                "Q2のチャネル別実績",
            ],
            facets=[
                FacetSpec(param="fiscalYear", label="Fiscal year", labels=_JA_FISCAL_YEAR, options=_FY_OPTIONS),
                FacetSpec(param="quarter", label="Quarter", labels=_JA_QUARTER, options=_QUARTER_OPTIONS),
                FacetSpec(param="groupBy", label="Group by", labels={"ja": "集計軸"}, options=group_by),
                FacetSpec(
                    param="region",
                    label="Region",
                    labels=_JA_REGION,
                    options=region,
                    emptyLabel="All regions",
                    emptyLabels=_JA_ALL_REGIONS,
                ),
            ],
            queries=[
                QueryTemplate(
                    path="summary",
                    paramMap={
                        "fiscalYear": "fy",
                        "quarter": "q",
                        "groupBy": "groupBy",
                        "region": "region",
                    },
                )
            ],
            drilldown=_summary_drilldown,
        )
    ),
    define_intent(
        IntentSpec(
            canonical="sales.trend",
            description="Show the time-series trend of revenue or units (monthly/quarterly)",
            source=_SOURCE,
            viewLabel="Trend",
            viewLabels={"ja": "推移"},
            params=object_schema(
                {
                    "fiscalYear": fiscal_year.optional(),
                    "region": region.enum().optional(),
                    "productId": string().optional(),
                    "metric": metric.enum().default("revenue"),
                    "granularity": granularity.enum().default("month"),
                }
            ),
            examples=[
                "Monthly revenue trend",
                "Show me the APAC trend",
                "Quarterly units trend",
                "売上の月次推移",
                "APACのトレンドを見せて",
                "四半期ごとの販売数推移",
            ],
            # productId is not surfaced as a facet (NL / drilldown only).
            facets=[
                FacetSpec(
                    param="fiscalYear",
                    label="Fiscal year",
                    labels=_JA_FISCAL_YEAR,
                    options=_FY_OPTIONS,
                    emptyLabel="All periods",
                    emptyLabels=_JA_ALL_PERIODS,
                ),
                FacetSpec(
                    param="region",
                    label="Region",
                    labels=_JA_REGION,
                    options=region,
                    emptyLabel="All regions",
                    emptyLabels=_JA_ALL_REGIONS,
                ),
                FacetSpec(param="metric", label="Metric", labels={"ja": "指標"}, options=metric),
                FacetSpec(param="granularity", label="Granularity", labels={"ja": "粒度"}, options=granularity),
            ],
            queries=[
                QueryTemplate(
                    path="trend",
                    paramMap={
                        "fiscalYear": "fy",
                        "region": "region",
                        "productId": "productId",
                        "metric": "metric",
                        "granularity": "granularity",
                    },
                )
            ],
        )
    ),
    define_intent(
        IntentSpec(
            canonical="sales.by_product",
            description="Show the sales ranking by product (top N)",
            source=_SOURCE,
            viewLabel="Product Ranking",
            viewLabels={"ja": "製品ランキング"},
            params=object_schema(
                {
                    "fiscalYear": fiscal_year.default(DEMO_FISCAL_YEAR),
                    "quarter": quarter.optional(),
                    "region": region.enum().optional(),
                    "metric": metric.enum().default("revenue"),
                    "topN": number(integer=True, minimum=1, maximum=20).default(5),
                }
            ),
            examples=[
                "Top 5 products by revenue",
                "What are this period's sales by product?",
                "Which product is selling best this period?",
                "製品別売上トップ5",
                "今期の製品別売上は?",
                "今期一番売れている製品は?",
            ],
            # metric is not surfaced as a facet (NL only). topN is a curated subset of the numeric range.
            facets=[
                FacetSpec(param="fiscalYear", label="Fiscal year", labels=_JA_FISCAL_YEAR, options=_FY_OPTIONS),
                FacetSpec(
                    param="quarter",
                    label="Quarter",
                    labels=_JA_QUARTER,
                    options=_QUARTER_OPTIONS,
                    emptyLabel="Full year",
                    emptyLabels=_JA_FULL_YEAR,
                ),
                FacetSpec(
                    param="region",
                    label="Region",
                    labels=_JA_REGION,
                    options=region,
                    emptyLabel="All regions",
                    emptyLabels=_JA_ALL_REGIONS,
                ),
                FacetSpec(
                    param="topN",
                    label="Count",
                    labels={"ja": "件数"},
                    options=[
                        {"value": "3", "label": "Top 3", "labels": {"ja": "上位3件"}},
                        {"value": "5", "label": "Top 5", "labels": {"ja": "上位5件"}},
                        {"value": "10", "label": "Top 10", "labels": {"ja": "上位10件"}},
                    ],
                ),
            ],
            queries=_by_product_queries,
        )
    ),
    define_intent(
        IntentSpec(
            canonical="sales.kpi_overview",
            description=(
                "Show this period's summary KPIs (total revenue, YoY, top region, target attainment) as cards. "
                "Each card's underlying `metric` selects the KPI kind "
                "(total_revenue/yoy/top_region/target_attainment), not the revenue/units metric used "
                "elsewhere (e.g. sales.trend)."
            ),
            source=_SOURCE,
            viewLabel="KPI Overview",
            viewLabels={"ja": "KPI概況"},
            params=object_schema(
                {"fiscalYear": fiscal_year.default(DEMO_FISCAL_YEAR), "quarter": quarter.optional()}
            ),
            examples=[
                "This quarter's summary",
                "List the KPIs",
                "Show the performance highlights",
                "今四半期のサマリー",
                "KPIを一覧で",
                "業績のハイライトを見せて",
            ],
            facets=[
                FacetSpec(param="fiscalYear", label="Fiscal year", labels=_JA_FISCAL_YEAR, options=_FY_OPTIONS),
                FacetSpec(
                    param="quarter",
                    label="Quarter",
                    labels=_JA_QUARTER,
                    options=_QUARTER_OPTIONS,
                    emptyLabel="Full year",
                    emptyLabels=_JA_FULL_YEAR,
                ),
            ],
            queries=_kpi_overview_queries,
        )
    ),
    define_intent(
        IntentSpec(
            canonical="sales.records",
            description="List the sales records (raw rows)",
            source=_SOURCE,
            viewLabel="Records",
            viewLabels={"ja": "明細"},
            params=object_schema(
                {
                    "fiscalYear": fiscal_year.optional(),
                    "quarter": quarter.optional(),
                    "region": region.enum().optional(),
                    "productId": string().optional(),
                    "channel": channel.enum().optional(),
                    "limit": number(integer=True, minimum=1, maximum=500).default(100),
                }
            ),
            examples=[
                "Show me Japan direct-sales records",
                "List the sales records",
                "日本の直販の明細を見せて",
                "売上明細一覧",
            ],
            # productId / limit are not surfaced as facets (NL / paging only).
            facets=[
                FacetSpec(
                    param="fiscalYear",
                    label="Fiscal year",
                    labels=_JA_FISCAL_YEAR,
                    options=_FY_OPTIONS,
                    emptyLabel="All periods",
                    emptyLabels=_JA_ALL_PERIODS,
                ),
                FacetSpec(
                    param="quarter",
                    label="Quarter",
                    labels=_JA_QUARTER,
                    options=_QUARTER_OPTIONS,
                    emptyLabel="Full year",
                    emptyLabels=_JA_FULL_YEAR,
                ),
                FacetSpec(
                    param="region",
                    label="Region",
                    labels=_JA_REGION,
                    options=region,
                    emptyLabel="All regions",
                    emptyLabels=_JA_ALL_REGIONS,
                ),
                FacetSpec(
                    param="channel",
                    label="Channel",
                    labels={"ja": "チャネル"},
                    options=channel,
                    emptyLabel="All channels",
                    emptyLabels={"ja": "すべてのチャネル"},
                ),
            ],
            queries=[
                QueryTemplate(
                    path="records",
                    paramMap={
                        "fiscalYear": "fy",
                        "quarter": "q",
                        "region": "region",
                        "productId": "productId",
                        "channel": "channel",
                        "limit": "limit",
                    },
                )
            ],
        )
    ),
    define_intent(
        IntentSpec(
            canonical="sales.target_attainment",
            description=(
                "Show targets, actuals, and attainment by region. Internally issues a kpi query with "
                'metric="target_attainment" — a KPI kind, not the revenue/units metric used elsewhere.'
            ),
            source=_SOURCE,
            viewLabel="Target Attainment",
            viewLabels={"ja": "目標達成"},
            params=object_schema(
                {"fiscalYear": fiscal_year.default(DEMO_FISCAL_YEAR), "quarter": quarter.default(DEMO_QUARTER_ATTAINMENT)}
            ),
            examples=[
                "What's the Q2 target attainment?",
                "Show attainment by region",
                "Q2の目標達成状況は?",
                "地域別の達成率を見せて",
            ],
            facets=[
                FacetSpec(
                    param="fiscalYear", label="Fiscal year", labels=_JA_FISCAL_YEAR, options=_FY_OPTIONS
                ),
                FacetSpec(param="quarter", label="Quarter", labels=_JA_QUARTER, options=_QUARTER_OPTIONS),
            ],
            queries=[
                QueryTemplate(path="targets", paramMap={"fiscalYear": "fy", "quarter": "q"}),
                QueryTemplate(
                    path="kpi",
                    paramMap={"fiscalYear": "fy", "quarter": "q"},
                    fixedParams={"metric": "target_attainment"},
                ),
            ],
        )
    ),
    define_intent(
        IntentSpec(
            canonical="sales.custom",
            description=(
                "A free-form visualization request that no known Intent can express "
                "(routed to L2 free generation). Holds the original request text in params.request"
            ),
            params=object_schema(
                {"request": string(min_length=1), "baseIntent": string().optional()}
            ),
            examples=[
                # Examples must be achievable from the supplied primary ref (monthly trend {month, revenue});
                # do not advertise forms that need dimensions the L2 widget cannot fetch (e.g. a region ×
                # product matrix — the sandbox allows only the primary ref).
                "Sales as a calendar heatmap",
                "Show monthly sales as a waterfall chart",
                "売上をカレンダーヒートマップで",
                "月次売上をウォーターフォールで見たい",
            ],
            # No facets (not surfaced in the GUI view). The fixed trend is a callback escape hatch.
            queries=_custom_queries,
        )
    ),
]

# The IntentDefs for SemanticPort (derived from the single definitions). All existing consumers reference these.
INTENT_DEFS: list[IntentDef] = [d.to_intent_def() for d in INTENT_DEFINITIONS]


class IntentCatalog:
    """Holds core Intents + promoted Intents and provides the vocabulary for NL/GUI normalization and resolve_query."""

    def __init__(self, defs: list[IntentDef] | None = None) -> None:
        source = INTENT_DEFS if defs is None else defs
        self._defs: dict[str, IntentDef] = {d.name: d for d in source}

    def get(self, name: str) -> IntentDef | None:
        return self._defs.get(name)

    def list_defs(self) -> list[IntentDef]:
        # Equivalent to TS's list(). In Python it is named list_defs to avoid collision with the builtin list
        # (also matching the codebase's list_operations / list_events naming).
        return list(self._defs.values())

    def names(self) -> list[str]:
        return list(self._defs.keys())

    def add(self, def_: IntentDef) -> None:
        """Adds a dynamic Intent via promotion (merged in from .data/intents.json)."""
        self._defs[def_.name] = def_

    def remove(self, name: str) -> None:
        """Removes a dynamic Intent via promotion withdrawal (unpublish)."""
        self._defs.pop(name, None)

    def normalize_params(self, name: str, params: JsonObject) -> JsonObject | None:
        """Validates params and returns the normalized form with defaults filled in. None on failure."""
        def_ = self._defs.get(name)
        if def_ is None:
            return None
        result = def_.params.safe_parse(params)
        return result.data if result.success else None


__all__ = [
    "INTENT_DEFINITIONS",
    "INTENT_DEFS",
    "IntentCatalog",
    "channel",
    "fiscal_year",
    "granularity",
    "group_by",
    "metric",
    "quarter",
    "region",
]

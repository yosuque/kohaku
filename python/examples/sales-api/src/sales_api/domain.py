"""Sales domain layer (port of TS: apps/sample-api/src/domain/{types,repo,queries}.ts).

- Types and vocabulary labels (types.ts)
- In-memory repository and dataVersion computation (repo.ts)
- The operation bodies of DomainPort (query://sales/{op}): aggregation queries (queries.ts)

All deterministic: the same params + the same dataVersion return the same result. Aggregated values always match
the sum of the records. The seed JSON is read directly from the repository root's apps/sample-api/src/domain/seed/
(no duplicated management of the data).
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from functools import cmp_to_key
from pathlib import Path
from typing import Any

from kohaku.spec import (
    ColumnType,
    DataShape,
    DataShapeColumn,
    JsonObject,
    JsonValue,
    TabularColumn,
    TabularData,
    js_string,
)

# --- types.ts: vocabulary (value sets + display labels) ---

REGIONS: tuple[str, ...] = ("japan", "north_america", "europe", "apac")
CHANNELS: tuple[str, ...] = ("direct", "partner", "online")

REGION_LABELS: dict[str, str] = {
    "japan": "Japan",
    "north_america": "North America",
    "europe": "Europe",
    "apac": "APAC",
}

# Channel code -> display label. For display only (table/chart cell values);
# query parameters, filters, and drilldown keys are handled as codes (direct, etc.).
CHANNEL_LABELS: dict[str, str] = {
    "direct": "Direct",
    "partner": "Partner",
    "online": "Online",
}

# Aggregation-axis code -> display label (the region/product/channel groupBy axis). Single source for
# _group_label below, matching TS's domain/types.ts GROUP_AXIS_LABELS (until now this axis's labels lived only
# in _group_label's if/elif chain, with no dict counterpart to the region/channel maps above).
GROUP_AXIS_LABELS: dict[str, str] = {
    "region": "Region",
    "product": "Product",
    "channel": "Channel",
}

# The demo "current period" default fiscal year (TS: apps/sample-api/src/intents/vocab.ts's DEMO_FISCAL_YEAR,
# where it is single-sourced alongside the fiscal-year range and re-exported by queries.ts). Defined here rather
# than in intents_catalog.py (which holds the rest of the vocabulary, including the fiscal-year range) because
# intents_catalog.py already imports from this module for the region/channel labels; the reverse import would
# create a circular import. intents_catalog.py imports this constant from here instead of redefining it, so both
# modules stay in sync. Kept equal to intents_catalog.FISCAL_YEAR_MAX (2026) by convention.
DEMO_FISCAL_YEAR = 2026


@dataclass(frozen=True)
class Product:
    id: str
    name: str
    category: str  # "software" | "hardware" | "services"
    unit_price: int  # JPY (JSON key unitPrice)


@dataclass(frozen=True)
class SalesRecord:
    id: str
    fiscal_year: int  # Fiscal year (starts in April; labeled by start year. FY2026 = 2026-04 to 2027-03)
    quarter: int  # Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar
    month: str  # Calendar month "2026-04"
    region: str
    product_id: str
    channel: str
    units: int
    # Amounts assume a single currency (JPY). Currency codes, FX, and multiple currencies are not handled.
    revenue: int  # JPY


@dataclass(frozen=True)
class SalesTarget:
    fiscal_year: int
    quarter: int
    region: str
    target_revenue: int


# --- repo.ts: seed loading and dataVersion ---

# A human-readable seed-version label. The mechanical identity of the content is guaranteed by seed/meta.json's contentHash.
_SEED_VERSION = "seed-20260610.1"

# Resolves the seed directory (env var takes priority -> default is relative to the repository root).
# domain.py: python/examples/sales-api/src/sales_api/domain.py -> parents[5] is the repository root.
_ENV_SEED_DIR = "KOHAKU_SALES_SEED_DIR"
_DEFAULT_SEED_DIR = Path(__file__).resolve().parents[5] / "apps/sample-api/src/domain/seed"


def default_seed_dir() -> Path:
    """The directory of the seed JSON. Uses the env var KOHAKU_SALES_SEED_DIR if present."""
    override = os.environ.get(_ENV_SEED_DIR)
    return Path(override) if override else _DEFAULT_SEED_DIR


def _load(seed_dir: Path, name: str) -> Any:
    try:
        return json.loads((seed_dir / name).read_text(encoding="utf-8"))
    except OSError as e:  # noqa: TRY003 -- matches the TS message
        raise RuntimeError(
            f"Cannot read seed data {name}. Run `pnpm seed` first ({e})"
        ) from e


def _read_seed_content_hash(seed_dir: Path) -> str | None:
    """The contentHash of seed/meta.json (machine-derived version info). None if unreadable (backward compatible)."""
    try:
        meta = json.loads((seed_dir / "meta.json").read_text(encoding="utf-8"))
    except OSError:
        return None
    value = meta.get("contentHash") if isinstance(meta, dict) else None
    return value if isinstance(value, str) and value != "" else None


class SalesRepo:
    """In-memory repository of sales data.

    dataVersion is composed of the seed-version tag + the bump count, and becomes a component of the cache key.
    The seed-version tag is the _SEED_VERSION constant plus a shortened content hash of seed/meta.json, so even if
    you forget to update the constant, dataVersion changes when the content changes. bump/notes simulate a data
    update (in-memory only, non-persistent).
    """

    def __init__(self, seed_dir: Path | None = None) -> None:
        d = seed_dir if seed_dir is not None else default_seed_dir()
        self.products: list[Product] = [
            Product(
                id=p["id"], name=p["name"], category=p["category"], unit_price=p["unitPrice"]
            )
            for p in _load(d, "products.json")
        ]
        self.records: list[SalesRecord] = [
            SalesRecord(
                id=r["id"],
                fiscal_year=r["fiscalYear"],
                quarter=r["quarter"],
                month=r["month"],
                region=r["region"],
                product_id=r["productId"],
                channel=r["channel"],
                units=r["units"],
                revenue=r["revenue"],
            )
            for r in _load(d, "sales-records.json")
        ]
        self.targets: list[SalesTarget] = [
            SalesTarget(
                fiscal_year=t["fiscalYear"],
                quarter=t["quarter"],
                region=t["region"],
                target_revenue=t["targetRevenue"],
            )
            for t in _load(d, "sales-targets.json")
        ]
        self.notes: list[str] = []
        # id -> name lookup (products are immutable, so built once; product_name is called per row in aggregation loops).
        self._product_names: dict[str, str] = {p.id: p.name for p in self.products}
        content_hash = _read_seed_content_hash(d)
        # dataVersion is assumed to contain no ':', so we append only the 12 hex digits with the "sha256:" scheme stripped to the version tag.
        hash_part = (
            f"+{content_hash.removeprefix('sha256:')[:12]}" if content_hash is not None else ""
        )
        self._seed_tag = f"{_SEED_VERSION}{hash_part}"
        self._bump_count = 0

    def data_version(self) -> str:
        return f"sales@{self._seed_tag}#bump-{self._bump_count}"

    def bump(self) -> str:
        """Simulates a data update: advances dataVersion to induce a cache miss."""
        self._bump_count += 1
        return self.data_version()

    def annotate(self, note: str) -> str:
        """The demo's write: adds one note and advances the data version."""
        self.notes.append(note)
        return self.bump()

    def product_name(self, product_id: str) -> str:
        return self._product_names.get(product_id, product_id)


# --- queries.ts: the operation bodies of DomainPort ---

# QueryArgs = dict[str, str | int | float | None] (ref params are strings; direct test calls may also pass numbers).
QueryArgs = dict[str, Any]


def _num(v: Any) -> int | float | None:
    """Coerce to a number. None/empty string/non-number becomes None; integral values are coerced to int.

    Strings support decimal numeric strings only. This diverges from TS's `Number(v)` on hex/octal/binary prefixes
    (`"0x10"` / `"0o17"` / `"0b101"`; JS interprets them but this implementation returns None) and digit-separator
    underscores (`"1_000"`; JS returns undefined but this implementation returns 1000), but the canonical intent path
    only ever passes decimal numeric strings, so there is no difference in actual behavior."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return 1 if v else 0  # JS: Number(true) === 1
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return _int_if_integral(v) if math.isfinite(v) else None
    if isinstance(v, str):
        try:
            f = float(v.strip()) if v.strip() != "" else 0.0
        except ValueError:
            return None
        return _int_if_integral(f) if math.isfinite(f) else None
    return None


def _str(v: Any) -> str | None:
    """Equivalent to TS's `v == null || v === "" ? undefined : String(v)`."""
    if v is None or v == "":
        return None
    return js_string(v)


def _int_if_integral(f: float) -> int | float:
    return int(f) if f.is_integer() else f


def _js_round(x: float) -> int:
    """JS's Math.round (half rounds toward +∞).

    Uses `x - floor(x) >= 0.5` rather than the more obvious `floor(x + 0.5)`: the addition form can round to a
    different double near an x.4999999999999999... boundary — e.g. `floor(0.49999999999999994 + 0.5)` computes
    `floor(1.0) == 1`, even though real Math.round(0.49999999999999994) is 0, because `x + 0.5` itself rounds
    to the nearest representable double before the comparison ever happens. Subtracting floor(x) instead keeps
    the fractional part exact, matching JS's Math.round bit-for-bit at that boundary.
    """
    floor_x = math.floor(x)
    return floor_x + 1 if x - floor_x >= 0.5 else floor_x


def _round1(ratio: float) -> int | float:
    """`Math.round(ratio * 1000) / 10` (a percentage to one decimal place). Integral values are coerced to int."""
    scaled = _js_round(ratio * 1000)
    return scaled // 10 if scaled % 10 == 0 else scaled / 10


def _read_metric(args: QueryArgs) -> str:
    """Reads the units|revenue metric arg (shared by summary/trend/shape_of), defaulting an unspecified or
    unrecognized value to revenue (TS: readMetric)."""
    return "units" if _str(args.get("metric")) == "units" else "revenue"


def _dim_label(dimension: str, code: str) -> str:
    """Dimension code -> display label. region/channel map codes to display labels (product passes through)."""
    if dimension == "region":
        return REGION_LABELS.get(code, code)
    if dimension == "channel":
        return CHANNEL_LABELS.get(code, code)
    return code


def _filter_records(repo: SalesRepo, args: QueryArgs) -> list[SalesRecord]:
    fy = _num(args.get("fy"))
    q = _num(args.get("q"))
    region = _str(args.get("region"))
    product_id = _str(args.get("productId"))
    channel = _str(args.get("channel"))
    return [
        r
        for r in repo.records
        if (fy is None or r.fiscal_year == fy)
        and (q is None or r.quarter == q)
        and (region is None or r.region == region)
        and (product_id is None or r.product_id == product_id)
        and (channel is None or r.channel == channel)
    ]


@dataclass(frozen=True)
class _ColumnSpec:
    """The single definition of a column. Both the rendering form (TabularColumn) and the shape meta (DataShape) are derived from here."""

    name: str
    label: str
    type: ColumnType
    role: str | None = None  # "dimension" | "measure" | "time"


def _to_columns(specs: list[_ColumnSpec]) -> list[TabularColumn]:
    return [TabularColumn(key=s.name, label=s.label, type=s.type) for s in specs]


def _to_shape(specs: list[_ColumnSpec], row_count_hint: int | None = None) -> DataShape:
    return DataShape(
        columns=[
            DataShapeColumn(name=s.name, type=s.type, role=s.role)  # type: ignore[arg-type]
            for s in specs
        ],
        rowCountHint=row_count_hint,
    )


def _group_label(group_by: str) -> str:
    return GROUP_AXIS_LABELS.get(group_by, "Region")


def _summary_columns(group_by: str) -> list[_ColumnSpec]:
    return [
        _ColumnSpec(group_by, _group_label(group_by), "string", "dimension"),
        _ColumnSpec("revenue", "Revenue (JPY)", "number", "measure"),
        _ColumnSpec("units", "Units", "number", "measure"),
    ]


def _trend_columns(granularity: str, metric: str) -> list[_ColumnSpec]:
    return [
        _ColumnSpec(granularity, "Month" if granularity == "month" else "Quarter", "string", "time"),
        _ColumnSpec(metric, "Revenue (JPY)" if metric == "revenue" else "Units", "number", "measure"),
    ]


def _records_columns() -> list[_ColumnSpec]:
    return [
        _ColumnSpec("month", "Month", "string", "dimension"),
        _ColumnSpec("region", "Region", "string", "dimension"),
        _ColumnSpec("product", "Product", "string", "dimension"),
        _ColumnSpec("channel", "Channel", "string", "dimension"),
        # The label for units is unified across aggregation and records.
        _ColumnSpec("units", "Units", "number", "measure"),
        _ColumnSpec("revenue", "Revenue (JPY)", "number", "measure"),
    ]


def _kpi_columns() -> list[_ColumnSpec]:
    return [
        _ColumnSpec("label", "Metric", "string", "dimension"),
        _ColumnSpec("value", "Value", "number", "measure"),
        _ColumnSpec("format", "Format", "string"),
        _ColumnSpec("note", "Note", "string"),
    ]


def _targets_columns() -> list[_ColumnSpec]:
    return [
        _ColumnSpec("region", "Region", "string", "dimension"),
        _ColumnSpec("actual", "Actual (JPY)", "number", "measure"),
        _ColumnSpec("target", "Target (JPY)", "number", "measure"),
        _ColumnSpec("attainment", "Attainment (%)", "number", "measure"),
        # Reason for a missing value. Only rows with no target set (target<=0) get a value; normal rows are None (blank in the table).
        _ColumnSpec("note", "Note", "string"),
    ]


def summary(repo: SalesRepo, args: QueryArgs) -> TabularData:
    """Aggregate sales by groupBy (region|product|channel). Sorted in descending order of metric (revenue|units), and topN uses the same basis."""
    group_by = _str(args.get("groupBy")) or "region"
    # The basis metric for sorting and topN slicing. Unknown values fall back to the default revenue.
    metric = "units" if _str(args.get("metric")) == "units" else "revenue"
    rows = _filter_records(repo, args)
    grouped: dict[str, dict[str, int]] = {}
    for r in rows:
        key = (
            repo.product_name(r.product_id)
            if group_by == "product"
            else r.channel
            if group_by == "channel"
            else r.region
        )
        acc = grouped.get(key)
        if acc is None:
            acc = {"revenue": 0, "units": 0}
            grouped[key] = acc
        acc["revenue"] += r.revenue
        acc["units"] += r.units
    result: list[JsonObject] = [
        {group_by: _dim_label(group_by, key), "revenue": v["revenue"], "units": v["units"]}
        for key, v in grouped.items()
    ]
    # Stable sort in descending metric order (like JS's Array.sort, ties preserve the original order).
    result.sort(key=lambda row: _as_number(row[metric]), reverse=True)
    top_n = _clamp_reserved_limit(_num(args.get("topN")))
    if top_n is not None:
        result = result[:top_n]
    return TabularData(
        columns=_to_columns(_summary_columns(group_by)),
        rows=result,
        dataVersion=repo.data_version(),
    )


def trend(repo: SalesRepo, args: QueryArgs) -> TabularData:
    """Monthly/quarterly time series."""
    granularity = _str(args.get("granularity")) or "month"
    # Unknown values fall back to the default revenue (symmetric with summary's metric normalization. M1). Without this
    # normalization the output columns / row keys (result / _trend_columns below) would be built with an unknown metric
    # name and diverge from the aggregated values.
    metric = _read_metric(args)
    rows = _filter_records(repo, args)
    # Quarters are fiscal-year based (starts in April; Q1=4-6/Q2=7-9/Q3=10-12/Q4=1-3). Calendar-year quarters and timezone boundaries are not considered.
    grouped: dict[str, int] = {}
    for r in rows:
        key = f"FY{r.fiscal_year} Q{r.quarter}" if granularity == "quarter" else r.month
        grouped[key] = grouped.get(key, 0) + (r.units if metric == "units" else r.revenue)
    result: list[JsonObject] = [{granularity: key, metric: value} for key, value in grouped.items()]
    # TS uses String(...).localeCompare. The keys ("YYYY-MM" / "FYyyyy Qn") match code-point order.
    result.sort(key=lambda row: str(row[granularity]))
    return TabularData(
        columns=_to_columns(_trend_columns(granularity, metric)),
        rows=result,
        dataVersion=repo.data_version(),
    )


def records(repo: SalesRepo, args: QueryArgs) -> TabularData:
    """Records (supports server-side paging/sorting). With reserved parameters unspecified, identical to the legacy behavior."""
    data_version = repo.data_version()
    # Default stable sort (month -> region -> productId). Applied first regardless of whether a reserved sort is present.
    matched = sorted(
        _filter_records(repo, args), key=lambda r: (r.month, r.region, r.product_id)
    )
    cols = _records_columns()
    mapped: list[JsonObject] = [
        {
            "month": r.month,
            # region/channel map their display value to a display label. Filters use codes, so they are unaffected.
            "region": _dim_label("region", r.region),
            "product": repo.product_name(r.product_id),
            "channel": _dim_label("channel", r.channel),
            "units": r.units,
            "revenue": r.revenue,
        }
        for r in matched
    ]

    # Reserved sort (_sort/_dir). Layered stably on top of the default order (unspecified or unknown column leaves the default order).
    sort_key_raw = _str(args.get("_sort"))
    col_names = {c.name for c in cols}
    sort_key = sort_key_raw if sort_key_raw is not None and sort_key_raw in col_names else None
    direction = "asc" if _str(args.get("_dir")) == "asc" else "desc"
    if sort_key is not None:
        sign = 1 if direction == "asc" else -1

        def cmp(a: JsonObject, b: JsonObject) -> int:
            av = a[sort_key]
            bv = b[sort_key]
            if _is_number(av) and _is_number(bv):
                base = -1 if av < bv else (1 if av > bv else 0)  # type: ignore[operator]
            else:
                # TS uses String(...).localeCompare. The current curated labels (region/channel display labels) and
                # product names match code-point order == localeCompare order. When adding labels in the future the
                # two orderings may diverge, so be careful about order (kept aligned with trend's note to the same effect).
                sa = "" if av is None else js_string(av)
                sb = "" if bv is None else js_string(bv)
                base = -1 if sa < sb else (1 if sa > sb else 0)
            return base * sign

        mapped.sort(key=cmp_to_key(cmp))

    # The cursor also embeds the sort context so pagination is stable across sort changes. The default stable sort is "_".
    sort_sig = "_" if sort_key is None else f"{sort_key}.{direction}"

    total = len(mapped)
    # Paging: _limit (clamped to 1-500) -> legacy limit (same clamp) -> default 100, in that order.
    limit = (
        _clamp_reserved_limit(_num(args.get("_limit")))
        or _clamp_reserved_limit(_num(args.get("limit")))
        or 100
    )
    offset = _parse_cursor_offset(_str(args.get("_cursor")), data_version, sort_sig)
    next_offset = offset + limit
    next_cursor = (
        f"{next_offset}:{sort_sig}:{data_version}" if next_offset < total else None
    )
    return TabularData(
        columns=_to_columns(cols),
        rows=mapped[offset:next_offset],
        dataVersion=data_version,
        total=total,
        nextCursor=next_cursor,
    )


def _parse_cursor_offset(cursor: str | None, data_version: str, sort_sig: str) -> int:
    """Restore offset from the opaque cursor `${offset}:${sortSig}:${dataVersion}`.

    Resets to the head (0) if either the version or the sort signature does not match, or on a malformed cursor.
    Splits into three on the first two `:` and treats the remainder as the dataVersion (none of them contain `:`).
    """
    if cursor is None:
        return 0
    i1 = cursor.find(":")
    if i1 < 0:
        return 0
    i2 = cursor.find(":", i1 + 1)
    if i2 < 0:
        return 0
    n = _num(cursor[:i1])
    sig = cursor[i1 + 1 : i2]
    version = cursor[i2 + 1 :]
    if version != data_version or sig != sort_sig or not isinstance(n, int) or n < 0:
        return 0
    return n


def _clamp_reserved_limit(raw: int | float | None) -> int | None:
    """Clamp the row-count limit to 1-500 (shared by records' reserved `_limit` and summary's topN).

    Invalid values (non-number, 0 or below) return None so the caller falls back to the default.
    """
    if raw is None or not math.isfinite(raw) or raw < 1:
        return None
    return min(math.floor(raw), 500)


def kpi(repo: SalesRepo, args: QueryArgs) -> TabularData:
    """A single KPI (1 row). metric: total_revenue | yoy | top_region | target_attainment

    Scope contract: a KPI is a company-wide aggregation filtered only by the fiscal period (fy/q) (it does not
    take dimension filters such as region).
    Missing value: when the denominator is 0, set value=None rather than 0% and show the reason in note.
    """
    metric = _str(args.get("metric")) or "total_revenue"
    fy = _num(args.get("fy"))
    fy = DEMO_FISCAL_YEAR if fy is None else fy
    q = _num(args.get("q"))
    current = _filter_records(repo, {"fy": fy, "q": q})
    current_revenue = sum(r.revenue for r in current)

    row: JsonObject
    if metric == "yoy":
        prior_revenue = sum(r.revenue for r in _filter_records(repo, {"fy": fy - 1, "q": q}))
        row = (
            {
                "label": "YoY",
                "value": _round1(current_revenue / prior_revenue - 1),
                "format": "percent",
                "note": f"vs. FY{fy - 1}",
            }
            if prior_revenue > 0
            else {
                "label": "YoY",
                "value": None,
                "format": "percent",
                "note": f"No baseline data (FY{fy - 1})",
            }
        )
    elif metric == "top_region":
        by_region: dict[str, int] = {}
        for r in current:
            by_region[r.region] = by_region.get(r.region, 0) + r.revenue
        top = max(by_region.items(), key=lambda kv: kv[1]) if by_region else None
        row = (
            {
                "label": "Top region",
                "value": _round1(top[1] / current_revenue),
                "format": "percent",
                "note": f"{REGION_LABELS[top[0]]} (share)",
            }
            if top is not None and current_revenue > 0
            else {
                "label": "Top region",
                "value": None,
                "format": "percent",
                "note": "No revenue in period",
            }
        )
    elif metric == "target_attainment":
        target_total = sum(
            t.target_revenue
            for t in repo.targets
            if t.fiscal_year == fy and (q is None or t.quarter == q)
        )
        row = (
            {
                "label": "Target attainment",
                "value": _round1(current_revenue / target_total),
                "format": "percent",
                "note": "Company-wide",
            }
            if target_total > 0
            else {
                "label": "Target attainment",
                "value": None,
                "format": "percent",
                "note": "No target set",
            }
        )
    else:
        # The note reflects the aggregation scope: with q the value is a quarterly total, so the note carries the
        # quarter too (otherwise a quarterly figure would read as the full-year total).
        row = {
            "label": "Total revenue",
            "value": current_revenue,
            "format": "currency",
            "note": f"FY{fy} Q{q}" if q is not None else f"FY{fy}",
        }

    return TabularData(
        columns=_to_columns(_kpi_columns()), rows=[row], dataVersion=repo.data_version()
    )


def targets(repo: SalesRepo, args: QueryArgs) -> TabularData:
    """Actual vs target by region."""
    fy = _num(args.get("fy"))
    fy = DEMO_FISCAL_YEAR if fy is None else fy
    q = _num(args.get("q"))
    actual_by_region: dict[str, int] = {}
    for r in _filter_records(repo, {"fy": fy, "q": q}):
        actual_by_region[r.region] = actual_by_region.get(r.region, 0) + r.revenue
    # Sum targets per region (preserving the appearance order of the targets array).
    by_region: dict[str, int] = {}
    for t in repo.targets:
        if t.fiscal_year == fy and (q is None or t.quarter == q):
            by_region[t.region] = by_region.get(t.region, 0) + t.target_revenue

    result: list[JsonObject] = [
        {
            "region": _dim_label("region", region),
            "actual": actual_by_region.get(region, 0),
            "target": target,
            # A 0 denominator (no target set) is set to None so it is not misread as "0% attainment", with the reason shown in note.
            "attainment": _round1(actual_by_region.get(region, 0) / target) if target > 0 else None,
            "note": None if target > 0 else "No target set",
        }
        for region, target in by_region.items()
    ]
    result.sort(key=lambda row: _as_number(row["actual"]), reverse=True)

    return TabularData(
        columns=_to_columns(_targets_columns()), rows=result, dataVersion=repo.data_version()
    )


OPERATIONS = {
    "summary": summary,
    "trend": trend,
    "records": records,
    "kpi": kpi,
    "targets": targets,
}


def shape_of(op: str, args: QueryArgs) -> DataShape | None:
    """For describeShape: the column metadata of each operation (no row data). Column definitions are unified in *_columns."""
    if op == "summary":
        group_by = _str(args.get("groupBy")) or "region"
        hint = 6 if group_by == "product" else 3 if group_by == "channel" else 4
        return _to_shape(_summary_columns(group_by), hint)
    if op == "trend":
        granularity = _str(args.get("granularity")) or "month"
        # Mirror trend()'s actual column set: normalize metric the same way trend() does, or the two column
        # sets diverge for an unrecognized metric string.
        metric = _read_metric(args)
        return _to_shape(_trend_columns(granularity, metric), 12 if granularity == "month" else 8)
    if op == "records":
        return _to_shape(_records_columns(), 100)
    if op == "kpi":
        return _to_shape(_kpi_columns(), 1)
    if op == "targets":
        return _to_shape(_targets_columns(), 4)
    return None


def _is_number(v: JsonValue) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _as_number(v: JsonValue) -> float:
    """Coerce to a number for use as a sort key (aggregation columns are always numeric, so effectively the identity)."""
    assert isinstance(v, (int, float)) and not isinstance(v, bool)
    return v


__all__ = [
    "CHANNELS",
    "CHANNEL_LABELS",
    "DEMO_FISCAL_YEAR",
    "REGIONS",
    "REGION_LABELS",
    "OPERATIONS",
    "Product",
    "QueryArgs",
    "SalesRecord",
    "SalesRepo",
    "SalesTarget",
    "default_seed_dir",
    "kpi",
    "records",
    "shape_of",
    "summary",
    "targets",
    "trend",
]

"""Usage analytics (B3. Port of TS packages/lineage/src/analytics.ts).

A pure function that folds the raw lineage event stream into an aggregate summary through which
operators can survey fallback rate, tier distribution, and latency. Read-only, with no I/O and no
clock (easy to test, cache-safe).

Differences from TS:
- LineageSummary / IntentUsage etc. are dataclasses. tiers / cache / promotions / fixations /
  byKind are fixed-key counters, so they stay as dict[str, int] (corresponding to TS plain objects).
- Quantile / rate computation is identical to TS (nearest-rank / total / (composed+total)).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from kohaku.spec import LineageEventRecord

TOP_INTENTS_DEFAULT = 10
TOP_INTENTS_MAX = 50


@dataclass(frozen=True)
class IntentUsage:
    """One row of a frequently-used intent (per view.composed intentHash, with canonical alongside)."""

    intentHash: str
    canonical: str
    count: int


@dataclass(frozen=True)
class FallbackSummary:
    total: int
    byKind: dict[str, int]
    """By kind (generation / negotiation / unspecified)."""
    rate: float
    """Fallback rate = total / (composed + total). 0 when the denominator is 0. 0..1."""


@dataclass(frozen=True)
class DurationSummary:
    """Quantiles (milliseconds) of view.composed payload.durationMs. Quantiles are None when the population is 0."""

    count: int
    p50: float | None
    p95: float | None
    p99: float | None
    max: float | None

    def to_wire(self) -> dict[str, Any]:
        """Always spell out the 4 quantile keys (emit `null` even when the population is 0).

        to_jsonable's dataclass default drops None fields, but TS (a plain object) returns
        `p50/p95/p99/max` as explicit `null` when the population is 0 (packages/lineage/src/
        analytics.ts's quantile -> null; JSON.stringify emits each key). durationMs alone needs
        this to_wire so these 4 keys become explicit null (the omission behavior of the other
        dataclasses is unchanged).
        """
        return {
            "count": self.count,
            "p50": self.p50,
            "p95": self.p95,
            "p99": self.p99,
            "max": self.max,
        }


@dataclass
class UsageRow:
    """One metering row: one tenant on one UTC day (design.md #74; port of TS `UsageRow`).

    Mutable on purpose: `summarize_usage` accumulates into its rows while folding, then returns them.
    Field order is the wire key order (`to_jsonable` follows it), identical to the TS object. `tenant`
    is the empty string for a record that carries none. `l2Generated` counts view.composed of tier L2
    whose cache was miss or bypass; `tokens` sums `payload.decision.usage` (a single-flight follower
    carries none).
    """

    day: str
    tenant: str
    composed: int
    cache: dict[str, int]
    tiers: dict[str, int]
    l2Generated: int
    fallbacks: int
    tokens: dict[str, int | float]
    fixated: int
    unfixated: int


@dataclass(frozen=True)
class SummarizeUsageOptions:
    """Options for summarize_usage. `bucket` is "day" (UTC), the only bucket."""

    bucket: str = "day"
    tenant: str | None = None
    since: str | None = None
    until: str | None = None


@dataclass(frozen=True)
class LineageSummary:
    """Lineage aggregate summary (the body of the analytics.read response).

    Only `usage` of the TS `review` / schemaSuggested / schemaEdited additions is mirrored here; the
    `review` block and those counters remain a known gap (docs/design.md, python/README.md).
    """

    events: int
    composed: int
    tiers: dict[str, int]
    cache: dict[str, int]
    fallback: FallbackSummary
    durationMs: DurationSummary
    topIntents: list[IntentUsage]
    promotions: dict[str, int]
    fixations: dict[str, int]
    usage: list[UsageRow]


@dataclass(frozen=True)
class SummarizeLineageOptions:
    """Filtering and formatting options for summarize_lineage."""

    tenant: str | None = None
    since: str | None = None
    until: str | None = None
    topIntentsLimit: int | None = None


def _quantile(sorted_values: list[float], p: float) -> float | None:
    """Nearest-rank percentile of an ascending-sorted array (None if empty)."""
    if len(sorted_values) == 0:
        return None
    rank = math.ceil((p / 100) * len(sorted_values))
    idx = min(max(rank - 1, 0), len(sorted_values) - 1)
    return sorted_values[idx]


def summarize_lineage(
    events: Sequence[LineageEventRecord],
    opts: SummarizeLineageOptions | None = None,
) -> LineageSummary:
    """Fold the raw lineage event stream into an aggregate summary (pure function, read-only)."""
    opts = opts if opts is not None else SummarizeLineageOptions()
    scoped: list[LineageEventRecord] = []
    for e in events:
        if opts.tenant is not None and e.tenant != opts.tenant:
            continue
        if opts.since is not None and e.ts < opts.since:
            continue
        if opts.until is not None and e.ts > opts.until:
            continue
        scoped.append(e)

    tiers = {"L0": 0, "L1": 0, "L2": 0}
    cache = {"hit": 0, "miss": 0, "bypass": 0, "fixated": 0, "other": 0}
    by_kind = {"generation": 0, "negotiation": 0, "unspecified": 0}
    promotions = {
        "generated": 0,
        "used": 0,
        "nominated": 0,
        "judged": 0,
        "reviewed": 0,
        "published": 0,
        "withdrawn": 0,
    }
    fixations = {"fixated": 0, "unfixated": 0}
    durations: list[float] = []
    # intentHash -> count (preserving insertion order) + canonical (first seen).
    intent_counts: dict[str, int] = {}
    intent_canonical: dict[str, str] = {}

    composed = 0
    fallback_total = 0

    for e in scoped:
        if e.type == "view.composed":
            composed += 1
            tier = str(e.payload.get("tier") or "")
            if tier in tiers:
                tiers[tier] += 1
            cache_key = str(e.payload.get("cache") or "")
            if cache_key in ("hit", "miss", "bypass", "fixated"):
                cache[cache_key] += 1
            else:
                cache["other"] += 1
            d = e.payload.get("durationMs")
            if isinstance(d, (int, float)) and not isinstance(d, bool) and math.isfinite(d):
                durations.append(d)
            intent_hash = e.payload.get("intentHash")
            if isinstance(intent_hash, str) and len(intent_hash) > 0:
                if intent_hash in intent_counts:
                    intent_counts[intent_hash] += 1
                else:
                    intent_counts[intent_hash] = 1
                    intent_canonical[intent_hash] = str(e.payload.get("canonical") or "")
        elif e.type == "view.fallback":
            fallback_total += 1
            kind = e.payload.get("kind")
            if kind in ("generation", "negotiation"):
                by_kind[kind] += 1
            else:
                by_kind["unspecified"] += 1
        elif e.type == "component.generated":
            promotions["generated"] += 1
        elif e.type == "component.used":
            promotions["used"] += 1
        elif e.type == "component.nominated":
            promotions["nominated"] += 1
        elif e.type == "component.judged":
            promotions["judged"] += 1
        elif e.type == "component.reviewed":
            promotions["reviewed"] += 1
        elif e.type == "component.published":
            promotions["published"] += 1
        elif e.type == "component.withdrawn":
            promotions["withdrawn"] += 1
        elif e.type == "intent.fixated":
            fixations["fixated"] += 1
        elif e.type == "intent.unfixated":
            fixations["unfixated"] += 1
        # intent.migrated (design.md #65) is intentionally ignored here: a migration-driven rewrite of a
        # fixation's pinnedSpec is neither a fresh fixation nor a removal, and has no counter of its own.

    durations.sort()
    denom = composed + fallback_total
    limit = opts.topIntentsLimit if opts.topIntentsLimit is not None else TOP_INTENTS_DEFAULT
    top_n = min(max(math.floor(limit), 1), TOP_INTENTS_MAX)
    top_intents = sorted(
        (
            IntentUsage(intentHash=h, canonical=intent_canonical[h], count=c)
            for h, c in intent_counts.items()
        ),
        key=lambda u: u.count,
        reverse=True,
    )[:top_n]

    return LineageSummary(
        events=len(scoped),
        composed=composed,
        tiers=tiers,
        cache=cache,
        fallback=FallbackSummary(
            total=fallback_total,
            byKind=by_kind,
            rate=(fallback_total / denom) if denom > 0 else 0,
        ),
        durationMs=DurationSummary(
            count=len(durations),
            p50=_quantile(durations, 50),
            p95=_quantile(durations, 95),
            p99=_quantile(durations, 99),
            max=durations[-1] if len(durations) > 0 else None,
        ),
        topIntents=top_intents,
        promotions=promotions,
        fixations=fixations,
        usage=summarize_usage(scoped, SummarizeUsageOptions(bucket="day")),
    )


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def summarize_usage(
    events: Sequence[LineageEventRecord],
    opts: SummarizeUsageOptions | None = None,
) -> list[UsageRow]:
    """Fold the lineage stream into per-day, per-tenant metering rows (pure function, read-only).

    Reads only view.composed / view.fallback / intent.fixated / intent.unfixated. Rows are ordered by day,
    then tenant, ascending (compared by UTF-16 code units, as the TS string comparison does).
    """
    opts = opts if opts is not None else SummarizeUsageOptions()
    rows: dict[tuple[str, str], UsageRow] = {}

    def row_for(e: LineageEventRecord) -> UsageRow:
        day = e.ts[:10]
        tenant = e.tenant if e.tenant is not None else ""
        key = (day, tenant)
        row = rows.get(key)
        if row is None:
            row = UsageRow(
                day=day,
                tenant=tenant,
                composed=0,
                cache={"hit": 0, "miss": 0, "bypass": 0, "fixated": 0},
                tiers={"L0": 0, "L1": 0, "L2": 0},
                l2Generated=0,
                fallbacks=0,
                tokens={"input": 0, "output": 0},
                fixated=0,
                unfixated=0,
            )
            rows[key] = row
        return row

    for e in events:
        if opts.tenant is not None and e.tenant != opts.tenant:
            continue
        if opts.since is not None and e.ts < opts.since:
            continue
        if opts.until is not None and e.ts > opts.until:
            continue
        if e.type == "view.composed":
            row = row_for(e)
            row.composed += 1
            tier = e.payload.get("tier")
            cache_key = e.payload.get("cache")
            if tier in ("L0", "L1", "L2"):
                row.tiers[tier] += 1
            if cache_key in ("hit", "miss", "bypass", "fixated"):
                row.cache[cache_key] += 1
            if tier == "L2" and cache_key in ("miss", "bypass"):
                row.l2Generated += 1
            decision = e.payload.get("decision")
            usage = decision.get("usage") if isinstance(decision, dict) else None
            if isinstance(usage, dict):
                if _is_number(usage.get("inputTokens")):
                    row.tokens["input"] += usage["inputTokens"]
                if _is_number(usage.get("outputTokens")):
                    row.tokens["output"] += usage["outputTokens"]
        elif e.type == "view.fallback":
            row_for(e).fallbacks += 1
        elif e.type == "intent.fixated":
            row_for(e).fixated += 1
        elif e.type == "intent.unfixated":
            row_for(e).unfixated += 1

    return sorted(rows.values(), key=lambda r: (r.day, r.tenant.encode("utf-16-be")))

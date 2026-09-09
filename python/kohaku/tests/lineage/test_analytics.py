"""Tests for the usage-analytics summarize_lineage (pytest port of packages/lineage/test/analytics.test.ts).

The event schema is unchanged (it only reads existing payloads). TS's toEqual (object) is replaced with
dict comparison / dataclass attribute comparison.
"""

from __future__ import annotations

import itertools
from typing import Any

from kohaku.lineage import IntentUsage, SummarizeLineageOptions, summarize_lineage
from kohaku.spec import LineageActor, LineageEventRecord

_seq = itertools.count()


def composed(
    *,
    tier: str = "L1",
    cache: str = "miss",
    duration_ms: float | None = None,
    intent_hash: str = "sha256:aaa",
    canonical: str = "sales.trend",
    tenant: str | None = None,
    ts: str = "2026-07-01T00:00:00.000Z",
) -> LineageEventRecord:
    payload: dict[str, Any] = {
        "tier": tier,
        "cache": cache,
        "intentHash": intent_hash,
        "canonical": canonical,
    }
    if duration_ms is not None:
        payload["durationMs"] = duration_ms
    return LineageEventRecord(
        id=f"ev-{next(_seq)}",
        ts=ts,
        actor=LineageActor(kind="model"),
        type="view.composed",
        payload=payload,
        tenant=tenant,
    )


def ev(
    type_: str,
    payload: dict[str, Any] | None = None,
    *,
    tenant: str | None = None,
    ts: str = "2026-07-01T00:00:00.000Z",
) -> LineageEventRecord:
    return LineageEventRecord(
        id=f"ev-{next(_seq)}",
        ts=ts,
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload or {},
        tenant=tenant,
    )


def test_composed_count_tiers_cache() -> None:
    s = summarize_lineage(
        [
            composed(tier="L0", cache="fixated"),
            composed(tier="L1", cache="hit"),
            composed(tier="L1", cache="miss"),
            composed(tier="L2", cache="bypass"),
            composed(tier="L1", cache="weird"),  # an unknown cache goes to other
        ]
    )
    assert s.composed == 5
    assert s.tiers == {"L0": 1, "L1": 3, "L2": 1}
    assert s.cache == {"hit": 1, "miss": 1, "bypass": 1, "fixated": 1, "other": 1}


def test_fallback_total_kind_rate() -> None:
    s = summarize_lineage(
        [
            composed(),
            composed(),
            composed(),
            ev("view.fallback", {"reason": "generation failed", "kind": "generation"}),
            ev("view.fallback", {"reason": "capability", "kind": "negotiation"}),
            ev("view.fallback", {"reason": "unknown"}),  # kind unspecified
        ]
    )
    assert s.composed == 3
    assert s.fallback.total == 3
    assert s.fallback.byKind == {"generation": 1, "negotiation": 1, "unspecified": 1}
    # rate = 3 / (3 composed + 3 fallback) = 0.5
    assert abs(s.fallback.rate - 0.5) < 1e-10


def test_fallback_rate_zero_when_no_composed_or_fallback() -> None:
    s = summarize_lineage([ev("view.rendered", {"specHash": "x"})])
    assert s.fallback.rate == 0
    assert s.composed == 0


def test_duration_quantiles_nearest_rank() -> None:
    s = summarize_lineage(
        [
            composed(duration_ms=10),
            composed(duration_ms=20),
            composed(duration_ms=30),
            composed(duration_ms=40),
            composed(duration_ms=100),
            composed(),  # no durationMs = outside the population
        ]
    )
    assert s.durationMs.count == 5
    # nearest-rank: p50 = ceil(0.5*5)=3rd=30, p95=ceil(0.95*5)=5th=100, p99 also 5th=100
    assert s.durationMs.p50 == 30
    assert s.durationMs.p95 == 100
    assert s.durationMs.p99 == 100
    assert s.durationMs.max == 100


def test_duration_null_when_absent() -> None:
    s = summarize_lineage([composed(), composed()])
    assert s.durationMs.count == 0
    assert s.durationMs.p50 is None
    assert s.durationMs.p95 is None
    assert s.durationMs.p99 is None
    assert s.durationMs.max is None


def test_duration_wire_shape_emits_explicit_null_for_empty_population() -> None:
    """Even with an empty population, durationMs emits the 4 quantile keys as explicit null (symmetric with TS; D1)."""
    from kohaku.host_rest.serialize import to_jsonable

    s = summarize_lineage([composed(), composed()])
    wire = to_jsonable(s)
    assert wire["durationMs"] == {
        "count": 0,
        "p50": None,
        "p95": None,
        "p99": None,
        "max": None,
    }
    # Other endpoints' None-omission behavior is unchanged (dataclasses like fallback stay as before).
    assert set(wire["durationMs"].keys()) == {"count", "p50", "p95", "p99", "max"}


def test_top_intents_desc_with_canonical() -> None:
    s = summarize_lineage(
        [
            composed(intent_hash="sha256:a", canonical="sales.trend"),
            composed(intent_hash="sha256:a", canonical="sales.trend"),
            composed(intent_hash="sha256:a", canonical="sales.trend"),
            composed(intent_hash="sha256:b", canonical="sales.kpi"),
            composed(intent_hash="sha256:b", canonical="sales.kpi"),
            composed(intent_hash="sha256:c", canonical="sales.calendar"),
        ],
        SummarizeLineageOptions(topIntentsLimit=2),
    )
    assert s.topIntents == [
        IntentUsage(intentHash="sha256:a", canonical="sales.trend", count=3),
        IntentUsage(intentHash="sha256:b", canonical="sales.kpi", count=2),
    ]


def test_promotions_and_fixations_counts() -> None:
    s = summarize_lineage(
        [
            ev("component.generated", {"artifactId": "art-1"}),
            ev("component.used", {"artifactId": "art-1"}),
            ev("component.used", {"artifactId": "art-1"}),
            ev("component.nominated", {"artifactId": "art-1"}),
            ev("component.judged", {"artifactId": "art-1"}),
            ev("component.reviewed", {"artifactId": "art-1"}),
            ev("component.published", {"artifactId": "art-1"}),
            ev("component.withdrawn", {"artifactId": "art-1"}),
            ev("intent.fixated", {"intentHash": "sha256:a"}),
            ev("intent.unfixated", {"intentHash": "sha256:a"}),
        ]
    )
    assert s.promotions == {
        "generated": 1,
        "used": 2,
        "nominated": 1,
        "judged": 1,
        "reviewed": 1,
        "published": 1,
        "withdrawn": 1,
    }
    assert s.fixations == {"fixated": 1, "unfixated": 1}


def test_tenant_scoped_summary() -> None:
    events = [
        composed(tenant="acme", tier="L1"),
        composed(tenant="acme", tier="L2"),
        composed(tenant="globex", tier="L1"),
        composed(tier="L0"),  # tenant not recorded (legacy)
    ]
    acme = summarize_lineage(events, SummarizeLineageOptions(tenant="acme"))
    assert acme.events == 2
    assert acme.composed == 2
    assert acme.tiers == {"L0": 0, "L1": 1, "L2": 1}

    globex = summarize_lineage(events, SummarizeLineageOptions(tenant="globex"))
    assert globex.composed == 1
    assert globex.tiers == {"L0": 0, "L1": 1, "L2": 0}

    # Unset tenant is all (including legacy).
    assert summarize_lineage(events).composed == 4


def test_since_until_bounds_inclusive() -> None:
    events = [
        composed(ts="2026-06-30T23:59:59.000Z"),
        composed(ts="2026-07-01T00:00:00.000Z"),
        composed(ts="2026-07-15T12:00:00.000Z"),
        composed(ts="2026-07-31T23:59:59.000Z"),
        composed(ts="2026-08-01T00:00:01.000Z"),
    ]
    s = summarize_lineage(
        events,
        SummarizeLineageOptions(
            since="2026-07-01T00:00:00.000Z", until="2026-07-31T23:59:59.000Z"
        ),
    )
    assert s.composed == 3


def test_empty_input_zero_summary() -> None:
    s = summarize_lineage([])
    assert s.events == 0
    assert s.composed == 0
    assert s.tiers == {"L0": 0, "L1": 0, "L2": 0}
    assert s.fallback.total == 0
    assert s.fallback.rate == 0
    assert s.topIntents == []

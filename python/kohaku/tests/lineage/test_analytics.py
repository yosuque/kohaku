"""Tests for the usage-analytics summarize_lineage (pytest port of packages/lineage/test/analytics.test.ts).

The event schema is unchanged (it only reads existing payloads). TS's toEqual (object) is replaced with
dict comparison / dataclass attribute comparison.
"""

from __future__ import annotations

import itertools
from typing import Any

from kohaku.lineage import (
    IntentUsage,
    SummarizeLineageOptions,
    SummarizeUsageOptions,
    summarize_lineage,
    summarize_usage,
)
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


# --- summarize_usage / LineageSummary.usage (per-day per-tenant metering, design.md #74) ---


def metered(
    *,
    tier: str = "L1",
    cache: str = "miss",
    tenant: str | None = None,
    ts: str = "2026-07-01T00:00:00.000Z",
    usage: dict[str, Any] | None = None,
    decision: Any = None,
) -> LineageEventRecord:
    base = composed(tier=tier, cache=cache, tenant=tenant, ts=ts)
    payload = dict(base.payload)
    if decision is not None:
        payload["decision"] = decision
    elif usage is not None:
        payload["decision"] = {"attempts": [], "usage": usage}
    return LineageEventRecord(
        id=base.id,
        ts=base.ts,
        actor=base.actor,
        type=base.type,
        payload=payload,
        tenant=tenant,
    )


def test_usage_l2_generated_only_for_l2_miss_or_bypass() -> None:
    rows = summarize_usage(
        [
            metered(tier="L2", cache="miss"),
            metered(tier="L2", cache="bypass"),
            metered(tier="L2", cache="hit"),
            metered(tier="L2", cache="fixated"),
            metered(tier="L1", cache="miss"),  # not L2
        ]
    )
    assert len(rows) == 1
    assert rows[0].composed == 5
    assert rows[0].l2Generated == 2
    assert rows[0].tiers == {"L0": 0, "L1": 1, "L2": 4}
    assert rows[0].cache == {"hit": 1, "miss": 2, "bypass": 1, "fixated": 1}


def test_usage_sums_decision_usage_tokens_ignoring_non_numeric() -> None:
    rows = summarize_usage(
        [
            metered(usage={"inputTokens": 100, "outputTokens": 20}),
            metered(usage={"inputTokens": 50, "outputTokens": 5}),
            metered(),  # no decision (a cache hit / L0)
            metered(decision={"attempts": []}),  # a single-flight follower: no usage
            metered(decision={"attempts": [], "usage": {"inputTokens": "x", "outputTokens": None}}),
            metered(decision={"attempts": [], "usage": {"inputTokens": True, "outputTokens": 1}}),
        ]
    )
    assert rows[0].tokens == {"input": 150, "output": 26}


def test_usage_unrecorded_tenant_is_empty_string_and_rows_split_per_tenant() -> None:
    rows = summarize_usage([metered(), metered(tenant="acme"), metered(tenant="acme")])
    assert [(r.tenant, r.composed) for r in rows] == [("", 1), ("acme", 2)]


def test_usage_buckets_by_utc_day_ordered_by_day_then_tenant() -> None:
    rows = summarize_usage(
        [
            metered(tenant="b", ts="2026-07-02T00:00:00.000Z"),
            metered(tenant="a", ts="2026-07-02T23:59:59.999Z"),
            metered(tenant="z", ts="2026-07-01T23:59:59.999Z"),
            metered(tenant="a", ts="2026-07-01T00:00:00.000Z"),
        ]
    )
    assert [f"{r.day}/{r.tenant}" for r in rows] == [
        "2026-07-01/a",
        "2026-07-01/z",
        "2026-07-02/a",
        "2026-07-02/b",
    ]


def test_usage_counts_fallbacks_and_fixations() -> None:
    rows = summarize_usage(
        [
            metered(tenant="acme"),
            ev("view.fallback", {"kind": "generation"}, tenant="acme"),
            ev("view.fallback", {"kind": "negotiation"}, tenant="acme"),
            ev("intent.fixated", {"intentHash": "sha256:a"}, tenant="acme"),
            ev("intent.unfixated", {"intentHash": "sha256:a"}, tenant="acme"),
            ev("intent.unfixated", {"intentHash": "sha256:b"}, tenant="acme"),
            ev("component.generated", {"artifactId": "a"}, tenant="acme"),  # ignored
        ]
    )
    assert len(rows) == 1
    assert (rows[0].composed, rows[0].fallbacks, rows[0].fixated, rows[0].unfixated) == (1, 2, 1, 2)


def test_usage_narrowing_options() -> None:
    events = [
        metered(tenant="acme", ts="2026-07-01T00:00:00.000Z"),
        metered(tenant="acme", ts="2026-07-03T00:00:00.000Z"),
        metered(tenant="globex", ts="2026-07-01T00:00:00.000Z"),
    ]
    rows = summarize_usage(
        events, SummarizeUsageOptions(tenant="acme", since="2026-07-02T00:00:00.000Z")
    )
    assert [f"{r.day}/{r.tenant}" for r in rows] == ["2026-07-03/acme"]


def test_lineage_summary_usage_follows_the_summary_window_and_empty_is_empty_list() -> None:
    assert summarize_lineage([]).usage == []
    events = [
        metered(tenant="acme", ts="2026-07-01T10:00:00.000Z"),
        metered(tenant="globex", ts="2026-07-01T10:00:00.000Z"),
    ]
    s = summarize_lineage(events, SummarizeLineageOptions(tenant="acme"))
    assert [r.tenant for r in s.usage] == ["acme"]
    assert s.usage[0].composed == s.composed


def test_usage_wire_shape_key_order_matches_ts() -> None:
    """The wire keys of a usage row are in the TS object's order (to_jsonable follows field order)."""
    from kohaku.host_rest.serialize import to_jsonable

    wire = to_jsonable(summarize_lineage([metered(tier="L2", usage={"inputTokens": 3, "outputTokens": 4})]))
    assert list(wire.keys())[-1] == "usage"
    row = wire["usage"][0]
    assert list(row.keys()) == [
        "day",
        "tenant",
        "composed",
        "cache",
        "tiers",
        "l2Generated",
        "fallbacks",
        "tokens",
        "fixated",
        "unfixated",
    ]
    assert list(row["cache"].keys()) == ["hit", "miss", "bypass", "fixated"]
    assert list(row["tiers"].keys()) == ["L0", "L1", "L2"]
    assert row["tokens"] == {"input": 3, "output": 4}
    assert row["tenant"] == ""

"""Tests for kohaku.host_core.rate_limit (port of packages/host-core/test/rate-limit.test.ts)."""

from __future__ import annotations

import asyncio

from kohaku.host_core import (
    RateLimiterErrorInfo,
    RateLimiterTakeParams,
    create_memory_rate_limit_store,
    create_rate_limiter,
)
from kohaku.spec import RateLimitResult, RateLimitRule, RateLimitStore


def test_allows_up_to_capacity_then_denies() -> None:
    async def run() -> None:
        store = create_memory_rate_limit_store()
        rule = RateLimitRule(capacity=3, refillPerSecond=1)
        for _ in range(3):
            assert (await store.take("k", 1, rule, 0)) == RateLimitResult(allow=True)
        denied = await store.take("k", 1, rule, 0)
        assert denied.allow is False
        assert denied.retryAfterMs is not None and denied.retryAfterMs > 0

    asyncio.run(run())


def test_refills_over_time_capped_at_capacity() -> None:
    async def run() -> None:
        store = create_memory_rate_limit_store()
        rule = RateLimitRule(capacity=2, refillPerSecond=1)  # 1 token/sec

        assert (await store.take("k", 2, rule, 0)).allow is True  # drains to 0
        assert (await store.take("k", 1, rule, 0)).allow is False  # still 0 at t=0
        assert (await store.take("k", 1, rule, 500)).allow is False  # +0.5s, still not enough
        assert (await store.take("k", 1, rule, 1500)).allow is True  # +1.5s total, enough for cost 1

        # Never exceeds capacity, however long the idle period.
        assert (await store.take("k", 2, rule, 1_000_000)).allow is True
        assert (await store.take("k", 1, rule, 1_000_000)).allow is False

    asyncio.run(run())


def test_retry_after_ms_reflects_the_shortfall_at_the_refill_rate() -> None:
    async def run() -> None:
        store = create_memory_rate_limit_store()
        rule = RateLimitRule(capacity=1, refillPerSecond=2)  # 2 tokens/sec
        await store.take("k", 1, rule, 0)  # drains to 0
        denied = await store.take("k", 1, rule, 0)
        assert denied.allow is False
        assert denied.retryAfterMs == 500  # 1 full token at 2/sec = 500ms

    asyncio.run(run())


def test_keys_are_independent_buckets() -> None:
    async def run() -> None:
        store = create_memory_rate_limit_store()
        rule = RateLimitRule(capacity=1, refillPerSecond=1)
        assert (await store.take("a", 1, rule, 0)).allow is True
        assert (await store.take("a", 1, rule, 0)).allow is False
        assert (await store.take("b", 1, rule, 0)).allow is True  # unaffected by "a"

    asyncio.run(run())


def test_zero_capacity_rule_denies_from_the_first_call() -> None:
    async def run() -> None:
        store = create_memory_rate_limit_store()
        rule = RateLimitRule(capacity=0, refillPerSecond=1)
        assert (await store.take("k", 1, rule, 0)).allow is False

    asyncio.run(run())


_RULE = RateLimitRule(capacity=1, refillPerSecond=1)


def test_rate_limiter_keys_buckets_by_tenant_principal_route_class() -> None:
    async def run() -> None:
        limiter = create_rate_limiter(create_memory_rate_limit_store(), now=lambda: 0)
        assert (
            await limiter.take(RateLimiterTakeParams(tenant="t1", principal="p1", routeClass="compose", rule=_RULE))
        ).allow is True
        # Same tenant/principal, different routeClass: independent bucket.
        assert (
            await limiter.take(RateLimiterTakeParams(tenant="t1", principal="p1", routeClass="action", rule=_RULE))
        ).allow is True
        # Same tenant/principal/routeClass again: bucket now exhausted.
        assert (
            await limiter.take(RateLimiterTakeParams(tenant="t1", principal="p1", routeClass="compose", rule=_RULE))
        ).allow is False
        # Different tenant, same principal/routeClass: independent bucket.
        assert (
            await limiter.take(RateLimiterTakeParams(tenant="t2", principal="p1", routeClass="compose", rule=_RULE))
        ).allow is True

    asyncio.run(run())


def test_does_not_collide_across_a_delimiter_ambiguous_tenant_principal_pair() -> None:
    """A plain f"{tenant}:{principal}:{routeClass}" join would collide these two: both render to
    "a:b:c:compose". Mirrors the TS test of the same intent."""

    class _RecordingKeyStore:
        def __init__(self) -> None:
            self.keys: list[str] = []

        async def take(self, key: str, cost: int, rule: RateLimitRule, now_ms: float) -> RateLimitResult:
            self.keys.append(key)
            return RateLimitResult(allow=True)

    async def run() -> None:
        store = _RecordingKeyStore()
        limiter = create_rate_limiter(store, now=lambda: 0)
        await limiter.take(RateLimiterTakeParams(tenant="a:b", principal="c", routeClass="compose", rule=_RULE))
        await limiter.take(RateLimiterTakeParams(tenant="a", principal="b:c", routeClass="compose", rule=_RULE))
        assert len(store.keys) == 2
        assert store.keys[0] != store.keys[1]

    asyncio.run(run())


def test_anonymous_caller_still_separates_by_route_class() -> None:
    async def run() -> None:
        limiter = create_rate_limiter(create_memory_rate_limit_store(), now=lambda: 0)
        assert (await limiter.take(RateLimiterTakeParams(routeClass="compose", rule=_RULE))).allow is True
        assert (await limiter.take(RateLimiterTakeParams(routeClass="compose", rule=_RULE))).allow is False
        assert (await limiter.take(RateLimiterTakeParams(routeClass="action", rule=_RULE))).allow is True

    asyncio.run(run())


def test_defaults_cost_to_1() -> None:
    async def run() -> None:
        limiter = create_rate_limiter(create_memory_rate_limit_store(), now=lambda: 0)
        params = RateLimiterTakeParams(routeClass="compose", rule=RateLimitRule(capacity=1, refillPerSecond=1))
        assert (await limiter.take(params)).allow is True
        assert (await limiter.take(params)).allow is False

    asyncio.run(run())


class _BrokenStore:
    async def take(self, key: str, cost: int, rule: RateLimitRule, now_ms: float) -> RateLimitResult:
        raise RuntimeError("rate limit store outage (test)")


def test_is_fail_open_on_a_store_error_reporting_it_via_on_error() -> None:
    async def run() -> None:
        reported: list[RateLimiterErrorInfo] = []
        store: RateLimitStore = _BrokenStore()
        limiter = create_rate_limiter(store, on_error=lambda info: reported.append(info), now=lambda: 0)

        result = await limiter.take(RateLimiterTakeParams(tenant="t1", principal="p1", routeClass="compose", rule=_RULE))
        assert result == RateLimitResult(allow=True)
        assert len(reported) == 1
        assert isinstance(reported[0].error, RuntimeError)

    asyncio.run(run())


def test_is_fail_open_even_without_an_on_error_hook_wired() -> None:
    async def run() -> None:
        store: RateLimitStore = _BrokenStore()
        limiter = create_rate_limiter(store, now=lambda: 0)
        result = await limiter.take(RateLimiterTakeParams(routeClass="compose", rule=_RULE))
        assert result == RateLimitResult(allow=True)

    asyncio.run(run())


def test_uses_the_injected_clock_not_the_real_one() -> None:
    async def run() -> None:
        clock = 0.0

        limiter = create_rate_limiter(create_memory_rate_limit_store(), now=lambda: clock)
        assert (await limiter.take(RateLimiterTakeParams(routeClass="compose", rule=_RULE))).allow is True
        assert (await limiter.take(RateLimiterTakeParams(routeClass="compose", rule=_RULE))).allow is False

        clock = 1000  # 1 second later per the injected clock -> exactly 1 token refilled
        assert (await limiter.take(RateLimiterTakeParams(routeClass="compose", rule=_RULE))).allow is True

    asyncio.run(run())

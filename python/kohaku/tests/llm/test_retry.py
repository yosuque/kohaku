"""Tests for the retry logic (the adapters/retry.test.ts scenarios as pytest)."""

from __future__ import annotations

import asyncio

import pytest

from kohaku.llm import RetryPolicy
from kohaku.llm.abort import AbortController, AbortError, AbortSignal
from kohaku.llm.retry import (
    ApiCallError,
    RetryDeps,
    is_retryable_provider_error,
    next_delay_ms,
    retryable_provider_error,
    with_provider_retry,
)

POLICY = RetryPolicy(max_retries=2, initial_delay_ms=250, backoff_factor=2.0, jitter=0.25)


def _api_error(
    *, is_retryable: bool, status_code: int = 500, response_headers: dict[str, str] | None = None
) -> ApiCallError:
    return ApiCallError(
        f"api {status_code}",
        is_retryable=is_retryable,
        status_code=status_code,
        response_headers=response_headers or {},
        url="https://example/api",
    )


def _make_deps() -> tuple[list[float], RetryDeps]:
    """Injected deps that record the wait and resolve immediately (the clock advances by the wait). random=0.5 gives zero jitter."""
    clock = [0.0]
    sleeps: list[float] = []

    async def sleep(ms: float, signal: AbortSignal) -> None:
        sleeps.append(ms)
        clock[0] += ms

    return sleeps, RetryDeps(sleep=sleep, now=lambda: clock[0], random=lambda: 0.5)


def _fresh_signal() -> AbortSignal:
    return AbortSignal()


def test_provider_fails_twice_then_succeeds_with_backoff() -> None:
    async def run() -> None:
        calls = 0

        async def fn() -> str:
            nonlocal calls
            calls += 1
            if calls <= 2:
                raise _api_error(is_retryable=True)
            return "ok"

        sleeps, deps = _make_deps()
        r = await with_provider_retry(
            fn, policy=POLICY, signal=_fresh_signal(), deadline=1_000_000, deps=deps
        )
        assert r == "ok"
        assert calls == 3
        # random=0.5 gives zero jitter, so base only: 250, 250*2=500.
        assert sleeps == [250, 500]

    asyncio.run(run())


def test_aborted_is_propagated_without_retry() -> None:
    async def run() -> None:
        calls = 0

        async def fn() -> str:
            nonlocal calls
            calls += 1
            raise AbortError("aborted")

        sleeps, deps = _make_deps()
        with pytest.raises(AbortError):
            await with_provider_retry(
                fn, policy=POLICY, signal=_fresh_signal(), deadline=1_000_000, deps=deps
            )
        assert calls == 1
        assert sleeps == []

    asyncio.run(run())


def test_already_aborted_signal_propagates_even_for_retryable() -> None:
    async def run() -> None:
        controller = AbortController()
        controller.abort()
        calls = 0

        async def fn() -> str:
            nonlocal calls
            calls += 1
            raise _api_error(is_retryable=True)

        sleeps, deps = _make_deps()
        with pytest.raises(ApiCallError):
            await with_provider_retry(
                fn, policy=POLICY, signal=controller.signal, deadline=1_000_000, deps=deps
            )
        assert calls == 1
        assert sleeps == []

    asyncio.run(run())


def test_gives_up_when_backoff_would_cross_deadline() -> None:
    async def run() -> None:
        calls = 0

        async def fn() -> str:
            nonlocal calls
            calls += 1
            raise _api_error(is_retryable=True)

        sleeps, deps = _make_deps()
        # clock=0, and the first backoff 250ms crosses deadline 100, so give up without waiting.
        with pytest.raises(ApiCallError):
            await with_provider_retry(
                fn, policy=POLICY, signal=_fresh_signal(), deadline=100, deps=deps
            )
        assert calls == 1
        assert sleeps == []

    asyncio.run(run())


def test_max_retries_zero_gives_up_after_one_attempt() -> None:
    async def run() -> None:
        calls = 0

        async def fn() -> str:
            nonlocal calls
            calls += 1
            raise _api_error(is_retryable=True)

        sleeps, deps = _make_deps()
        policy = RetryPolicy(
            max_retries=0, initial_delay_ms=250, backoff_factor=2.0, jitter=0.25
        )
        with pytest.raises(ApiCallError):
            await with_provider_retry(
                fn, policy=policy, signal=_fresh_signal(), deadline=1_000_000, deps=deps
            )
        assert calls == 1
        assert sleeps == []

    asyncio.run(run())


def test_non_retryable_provider_propagates_immediately() -> None:
    async def run() -> None:
        calls = 0

        async def fn() -> str:
            nonlocal calls
            calls += 1
            raise _api_error(is_retryable=False, status_code=400)

        sleeps, deps = _make_deps()
        with pytest.raises(ApiCallError) as exc:
            await with_provider_retry(
                fn, policy=POLICY, signal=_fresh_signal(), deadline=1_000_000, deps=deps
            )
        assert exc.value.status_code == 400
        assert calls == 1
        assert sleeps == []

    asyncio.run(run())


def test_respects_retry_after_over_backoff() -> None:
    async def run() -> None:
        calls = 0

        async def fn() -> str:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise _api_error(is_retryable=True, response_headers={"retry-after": "2"})
            return "ok"

        sleeps, deps = _make_deps()
        r = await with_provider_retry(
            fn, policy=POLICY, signal=_fresh_signal(), deadline=1_000_000, deps=deps
        )
        assert r == "ok"
        # retry-after: 2 seconds = 2000ms (not the exponential backoff 250).
        assert sleeps == [2000]

    asyncio.run(run())


def test_retryable_provider_error_detection() -> None:
    # A retryable PROVIDER without headers is (True, None).
    assert retryable_provider_error(_api_error(is_retryable=True)) == (True, None)
    assert is_retryable_provider_error(_api_error(is_retryable=True)) is True
    # The retry-after-ms header is returned as milliseconds.
    err = _api_error(is_retryable=True, response_headers={"retry-after-ms": "1500"})
    assert retryable_provider_error(err) == (True, 1500.0)
    # A non-retryable PROVIDER / non-ApiCallError is (False, None).
    assert retryable_provider_error(_api_error(is_retryable=False)) == (False, None)
    assert retryable_provider_error(RuntimeError("plain")) == (False, None)
    assert is_retryable_provider_error(_api_error(is_retryable=False)) is False
    assert is_retryable_provider_error(RuntimeError("plain")) is False


def test_detects_api_call_error_buried_in_cause_chain() -> None:
    wrapper = RuntimeError("wrapper")
    wrapper.__cause__ = _api_error(is_retryable=True)
    assert is_retryable_provider_error(wrapper) is True


def test_next_delay_ms_stays_within_jitter_range() -> None:
    # attempt 0: base=250, jitter=0.25 → [187.5, 312.5]
    assert next_delay_ms(POLICY, 0, None, lambda: 0) == 188  # 250*(1-0.25)=187.5 → 188
    assert next_delay_ms(POLICY, 0, None, lambda: 0.5) == 250  # center
    assert next_delay_ms(POLICY, 0, None, lambda: 1) == 313  # 250*(1+0.25)=312.5 → 313
    # attempt 1: base=500
    assert next_delay_ms(POLICY, 1, None, lambda: 0.5) == 500


def test_next_delay_ms_prefers_retry_after() -> None:
    assert next_delay_ms(POLICY, 3, 1234, lambda: 0.5) == 1234

"""Tests for the retry logic (the adapters/retry.test.ts scenarios as pytest)."""

from __future__ import annotations

import asyncio
import time
from email.utils import formatdate

import pytest

from kohaku.llm import RetryPolicy
from kohaku.llm.abort import AbortController, AbortError, AbortSignal, default_sleep
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


def test_default_sleep_rejects_immediately_when_already_aborted() -> None:
    async def run() -> None:
        controller = AbortController()
        reason = RuntimeError("already aborted")
        controller.abort(reason)
        with pytest.raises(RuntimeError, match="already aborted"):
            await default_sleep(1000, controller.signal)

    asyncio.run(run())


def test_default_sleep_rejects_when_aborted_while_waiting() -> None:
    async def run() -> None:
        controller = AbortController()
        task = asyncio.ensure_future(default_sleep(1000, controller.signal))
        # Let the task run up to `await future` (registering its abort listener) before aborting, so
        # this actually exercises the mid-wait abort path rather than the already-aborted short-circuit.
        await asyncio.sleep(0)
        controller.abort(RuntimeError("cancelled mid-wait"))
        with pytest.raises(RuntimeError, match="cancelled mid-wait"):
            await task

    asyncio.run(run())


def test_default_sleep_removes_its_listener_after_normal_completion() -> None:
    async def run() -> None:
        controller = AbortController()
        # ms>0 so the wait actually registers a listener (default_sleep short-circuits for ms<=0
        # without ever calling add_listener, which would make this assertion vacuous).
        await default_sleep(5, controller.signal)
        assert controller.signal._listeners == []  # noqa: SLF001 -- pinning the no-leak contract

    asyncio.run(run())


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


def test_retry_after_http_date_in_the_future_returns_positive_ms() -> None:
    future = formatdate(time.time() + 60, usegmt=True)
    err = _api_error(is_retryable=True, response_headers={"retry-after": future})
    retryable, retry_after_ms = retryable_provider_error(err)
    assert retryable is True
    assert retry_after_ms is not None
    # Allow slack for the two time.time() calls (this test's and _retry_after_from_headers's) not
    # landing on the exact same instant.
    assert retry_after_ms > 50_000


def test_retry_after_http_date_in_the_past_is_treated_as_no_retry_after() -> None:
    past = formatdate(time.time() - 60, usegmt=True)
    err = _api_error(is_retryable=True, response_headers={"retry-after": past})
    assert retryable_provider_error(err) == (True, None)


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

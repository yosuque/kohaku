"""Jitter-added exponential backoff retry limited to transient PROVIDER-side failures (port of TS adapters/retry.ts).

This single file centralizes the retry policy. Design-level separations:
- ABORTED (caller cancellation / timeout exceeded) propagates immediately and is not retried.
- INVALID_OUTPUT / CONFIG are out of scope (schema-derived failures are not fixed by retrying).
- `is_retryable=False` PROVIDER (e.g. ollama's structured-output 400) is also out of scope. That is a
  structured-output incompatibility handled by the prompt JSON fallback path (auto). Retrying here would
  cause a double spend of "fallback × backoff", so it propagates immediately.
- The whole sequence never exceeds the timeout (deadline). If the next wait would not fit the remaining budget, give up.
"""

from __future__ import annotations

import math
import random as _random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

from .abort import AbortError, AbortSignal, default_sleep
from .env import RetryPolicy


class ApiCallError(Exception):
    """A failure of an OpenAI-compatible API call (equivalent to the AI SDK's APICallError).

    Always carries `is_retryable` (bool), along with `status_code` / `response_headers`.
    Retryability and Retry-After are decided from this information.
    """

    def __init__(
        self,
        message: str,
        *,
        is_retryable: bool,
        status_code: int | None = None,
        response_headers: dict[str, str] | None = None,
        url: str | None = None,
    ) -> None:
        super().__init__(message)
        self.is_retryable = is_retryable
        self.status_code = status_code
        self.response_headers: dict[str, str] = response_headers if response_headers is not None else {}
        self.url = url


type SleepFn = Callable[[float, AbortSignal], Awaitable[None]]


def _monotonic_ms() -> float:
    return time.monotonic() * 1000.0


@dataclass(frozen=True)
class RetryDeps:
    """Injectable side effects for determinism (tests substitute the wait, clock, and randomness)."""

    sleep: SleepFn = default_sleep
    now: Callable[[], float] = _monotonic_ms
    random: Callable[[], float] = _random.random


default_retry_deps = RetryDeps()


def _round_half_up(x: float) -> int:
    """Match JS's Math.round (rounds halves toward +∞)."""
    return math.floor(x + 0.5)


def _is_abort_like(err: BaseException, signal: AbortSignal) -> bool:
    """Whether the error originates from an abort/timeout (decided by signal being aborted or by AbortError)."""
    if signal.aborted:
        return True
    return isinstance(err, AbortError)


def _find_api_call_error(err: object, depth: int = 0) -> object | None:
    """Structurally search for an ApiCallError (also following the cause chain)."""
    if err is None or depth > 4:
        return None
    if isinstance(err, ApiCallError):
        return err
    is_retryable = getattr(err, "is_retryable", None)
    if isinstance(is_retryable, bool) and (
        hasattr(err, "response_headers") or hasattr(err, "status_code") or hasattr(err, "url")
    ):
        return err
    return _find_api_call_error(getattr(err, "__cause__", None), depth + 1)


def _retry_after_from_headers(headers: dict[str, str] | None) -> float | None:
    """Interpret Retry-After-like headers (retry-after-ms / retry-after) as milliseconds."""
    if not headers:
        return None
    retry_after_ms = headers.get("retry-after-ms")
    if retry_after_ms is not None:
        try:
            ms = float(retry_after_ms)
        except ValueError:
            ms = float("nan")
        if math.isfinite(ms) and ms >= 0:
            return ms
    retry_after = headers.get("retry-after")
    if retry_after is not None:
        # Seconds (e.g. "2") or an HTTP date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT").
        try:
            seconds = float(retry_after)
        except ValueError:
            seconds = float("nan")
        if math.isfinite(seconds) and seconds >= 0:
            return seconds * 1000.0
        try:
            parsed = parsedate_to_datetime(retry_after)
            date_ms = parsed.timestamp() * 1000.0 - time.time() * 1000.0
        except (TypeError, ValueError):
            return None
        if math.isfinite(date_ms) and date_ms >= 0:
            return date_ms
    return None


def retryable_provider_error(err: object) -> tuple[bool, float | None]:
    """Decide whether this is a retryable PROVIDER failure.

    Return value (retryable, retry_after_ms):
    - (False, None): not retryable (non-ApiCallError / is_retryable=False)
    - (True, None): retryable, no Retry-After (leave it to exponential backoff)
    - (True, number): retryable, with Retry-After (respect this wait)
    """
    api = _find_api_call_error(err)
    if api is None or getattr(api, "is_retryable", None) is not True:
        return (False, None)
    return (True, _retry_after_from_headers(getattr(api, "response_headers", None)))


def is_retryable_provider_error(err: object) -> bool:
    """Whether this is a retryable PROVIDER failure (the boolean version used by the auto fallback branch)."""
    return retryable_provider_error(err)[0]


def next_delay_ms(
    policy: RetryPolicy, attempt: int, retry_after_ms: float | None, rand: Callable[[], float]
) -> int:
    """The next backoff wait (milliseconds). If Retry-After is present, respect it; otherwise perturb
    base = initial_delay_ms * backoff_factor^attempt by ±jitter."""
    if retry_after_ms is not None:
        return max(0, _round_half_up(retry_after_ms))
    base = policy.initial_delay_ms * policy.backoff_factor**attempt
    # Map rand() ∈ [0,1) to [-1,1) and perturb as a ratio of base.
    delta = (rand() * 2 - 1) * policy.jitter * base
    return max(0, _round_half_up(base + delta))


async def with_provider_retry[T](
    fn: Callable[[], Awaitable[T]],
    *,
    policy: RetryPolicy,
    signal: AbortSignal,
    deadline: float,
    deps: RetryDeps | None = None,
) -> T:
    """Run `fn` and, on a retryable PROVIDER failure, retry with exponential backoff.

    Anything else (abort / non-retryable PROVIDER / schema-derived, etc.) is re-raised without being caught.
    If a wait would cross `deadline` (absolute time in ms = now() + timeout), give up without waiting.
    """
    d = deps if deps is not None else default_retry_deps
    attempt = 0
    while True:
        try:
            return await fn()
        except BaseException as err:
            # Do not retry on abort/timeout (if the shared signal is aborted, further attempts are pointless).
            if _is_abort_like(err, signal):
                raise
            retryable, retry_after_ms = retryable_provider_error(err)
            # Propagate immediately if not retryable or the limit is reached.
            if not retryable or attempt >= policy.max_retries:
                raise
            wait_ms = next_delay_ms(policy, attempt, retry_after_ms, d.random)
            # If waiting would only cross the deadline and get timed out right after, give up now without waiting.
            if d.now() + wait_ms >= deadline:
                raise
            await d.sleep(wait_ms, signal)
            attempt += 1

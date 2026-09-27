"""RateLimitStore-backed rate limiting (port of packages/host-core/src/rate-limit.ts)."""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass

from kohaku.spec import RateLimitResult, RateLimitRule, RateLimitStore

from .errors import notify_hook


@dataclass
class _Bucket:
    """One key's token-bucket state (MemoryRateLimitStore's internal bookkeeping)."""

    tokens: float
    last_refill_ms: float


class MemoryRateLimitStore:
    """A pure in-process token-bucket RateLimitStore (the Zero-Port default, and the reference
    implementation this module's own tests exercise). Mirrors kohaku.storage's file-backed port in
    spirit: state lives only in this process and is lost on restart, with no cross-process coordination
    -- a product running several host instances needs a shared backing store (Redis, etc.) implementing
    the same RateLimitStore protocol instead.

    A key's bucket starts full (rule.capacity tokens) on first use, refills continuously at
    rule.refillPerSecond (capped at rule.capacity), and never actively expires -- a key that stops being
    used simply stops accumulating history beyond rule.capacity, so the map does grow with the number of
    distinct keys ever seen. A product with unboundedly many keys (e.g. one bucket per anonymous IP)
    should prefer a backing store with its own eviction instead.

    Structurally satisfies kohaku.spec.RateLimitStore (a Protocol) without inheriting from it.
    """

    def __init__(self) -> None:
        self._buckets: dict[str, _Bucket] = {}

    async def take(self, key: str, cost: int, rule: RateLimitRule, now_ms: float) -> RateLimitResult:
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(tokens=rule.capacity, last_refill_ms=now_ms)
            self._buckets[key] = bucket
        else:
            elapsed_seconds = max(0.0, now_ms - bucket.last_refill_ms) / 1000
            bucket.tokens = min(rule.capacity, bucket.tokens + elapsed_seconds * rule.refillPerSecond)
            bucket.last_refill_ms = now_ms

        if bucket.tokens >= cost:
            bucket.tokens -= cost
            return RateLimitResult(allow=True)
        shortfall = cost - bucket.tokens
        return RateLimitResult(allow=False, retryAfterMs=math.ceil((shortfall / rule.refillPerSecond) * 1000))


def create_memory_rate_limit_store() -> RateLimitStore:
    """Factory matching TS's createMemoryRateLimitStore naming (kohaku's other create_* port factories)."""
    return MemoryRateLimitStore()


@dataclass(frozen=True)
class RateLimiterErrorInfo:
    """Info passed to create_rate_limiter's on_error when the backing store's take raises."""

    error: BaseException
    routeClass: str
    tenant: str | None = None
    principal: str | None = None


@dataclass(frozen=True)
class RateLimiterTakeParams:
    """Parameters for one RateLimiter.take call."""

    routeClass: str
    """The route class the rule applies to (e.g. "compose"/"action"/"resolve" -- see the Policy file's
    rateLimits section, kohaku.spec.policy)."""
    rule: RateLimitRule
    tenant: str | None = None
    """SessionContext.tenant. None = tenant-neutral (a single shared bucket across tenants for this
    principal/routeClass)."""
    principal: str | None = None
    """The caller's principal id. None = a single shared bucket across principals for this
    tenant/routeClass (the anonymous-caller case)."""
    cost: int = 1
    """Tokens to consume for this call."""


class RateLimiter:
    """Built by create_rate_limiter; see that function's doc for the full contract."""

    def __init__(
        self,
        store: RateLimitStore,
        on_error: Callable[[RateLimiterErrorInfo], object] | None,
        now: Callable[[], float],
    ) -> None:
        self._store = store
        self._on_error = on_error
        self._now = now

    async def take(self, params: RateLimiterTakeParams) -> RateLimitResult:
        key = f"{params.tenant or ''}:{params.principal or ''}:{params.routeClass}"
        try:
            return await self._store.take(key, params.cost, params.rule, self._now())
        except Exception as e:  # noqa: BLE001 — a rate-limit store outage must fail open, never break the request
            await notify_hook(
                self._on_error,
                RateLimiterErrorInfo(
                    error=e, tenant=params.tenant, principal=params.principal, routeClass=params.routeClass
                ),
            )
            return RateLimitResult(allow=True)


def _default_now_ms() -> float:
    """Epoch milliseconds (matches TS create_rate_limiter's Date.now() default exactly, unlike
    composer's create_deadline_guard, which deliberately uses time.monotonic() seconds for a
    same-process-only elapsed-time measurement never compared across processes). RateLimitStore.take's
    now_ms is meant to be comparable against a store's own persisted last-refill timestamp, which a
    distributed backing store (e.g. Redis) may key against wall-clock time on its own side."""
    return time.time() * 1000


def create_rate_limiter(
    store: RateLimitStore,
    on_error: Callable[[RateLimiterErrorInfo], object] | None = None,
    now: Callable[[], float] = _default_now_ms,
) -> RateLimiter:
    """Builds a RateLimiter over a RateLimitStore, keying each bucket by
    "{tenant}:{principal}:{routeClass}" (tenant/principal default to the empty string when unset, so an
    anonymous caller still gets its own bucket per tenant/routeClass rather than colliding with every
    other anonymous caller across route classes -- the MCP profile's "no tenant, no principal" case
    still separates compose from action this way).

    Fail-open on a store error: the request is allowed through (RateLimitResult(allow=True)), and the
    error is reported via on_error (silent, fire-and-forget, if unwired -- the same notify_hook
    convention as ComposeObserver's hooks) rather than left unobserved or turned into a hard failure. A
    rate limiter outage must never itself become a reason no request can be served.
    """
    return RateLimiter(store, on_error, now)

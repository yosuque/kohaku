"""RateLimitStore-backed rate limiting (port of packages/host-core/src/rate-limit.ts)."""

from __future__ import annotations

import json
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


DEFAULT_MAX_MEMORY_ENTRIES = 10_000
"""A sensible default cap on the number of distinct buckets/ledger entries an in-process, dict-backed
store keeps at once -- see MemoryRateLimitStore/DailyTokenLedger's max_entries (matches the TS port's
DEFAULT_MAX_MEMORY_ENTRIES)."""


class MemoryRateLimitStore:
    """A pure in-process token-bucket RateLimitStore (the Zero-Port default, and the reference
    implementation this module's own tests exercise). Mirrors kohaku.storage's file-backed port in
    spirit: state lives only in this process and is lost on restart, with no cross-process coordination
    -- a product running several host instances needs a shared backing store (Redis, etc.) implementing
    the same RateLimitStore protocol instead.

    A key's bucket starts full (rule.capacity tokens) on first use, refills continuously at
    rule.refillPerSecond (capped at rule.capacity), and never actively expires on its own -- a key that
    stops being used would otherwise keep its bucket forever, so the dict would grow with the number of
    distinct keys ever seen (unbounded for a product with unboundedly many keys, e.g. one bucket per
    anonymous IP or per rotated header value). max_entries (default DEFAULT_MAX_MEMORY_ENTRIES) bounds
    that growth with LRU eviction: a plain dict iterates in insertion order (Python 3.7+), and every
    take() call deletes then re-inserts the accessed key, so the first key in iteration order is always
    the least-recently-used one -- evicted only when a brand-new key would otherwise push the dict over
    the cap. A rate limit is only as strong as the identity it keys on: see docs/user-guide.md's
    Policy-as-Code section for why an unauthenticated caller that can vary its own tenant/principal
    header can just as easily rotate through buckets as it can exhaust this cap.

    Structurally satisfies kohaku.spec.RateLimitStore (a Protocol) without inheriting from it.
    """

    def __init__(self, max_entries: int = DEFAULT_MAX_MEMORY_ENTRIES) -> None:
        self._max_entries = max_entries
        self._buckets: dict[str, _Bucket] = {}

    async def take(self, key: str, cost: int, rule: RateLimitRule, now_ms: float) -> RateLimitResult:
        existing = self._buckets.get(key)
        if existing is not None:
            del self._buckets[key]  # reinsert below to mark as most-recently-used
            elapsed_seconds = max(0.0, now_ms - existing.last_refill_ms) / 1000
            bucket = _Bucket(
                tokens=min(rule.capacity, existing.tokens + elapsed_seconds * rule.refillPerSecond),
                last_refill_ms=now_ms,
            )
        else:
            bucket = _Bucket(tokens=rule.capacity, last_refill_ms=now_ms)
            if len(self._buckets) >= self._max_entries:
                oldest_key = next(iter(self._buckets), None)
                if oldest_key is not None:
                    del self._buckets[oldest_key]
        self._buckets[key] = bucket

        if bucket.tokens >= cost:
            bucket.tokens -= cost
            return RateLimitResult(allow=True)
        shortfall = cost - bucket.tokens
        return RateLimitResult(allow=False, retryAfterMs=math.ceil((shortfall / rule.refillPerSecond) * 1000))


def create_memory_rate_limit_store(max_entries: int = DEFAULT_MAX_MEMORY_ENTRIES) -> RateLimitStore:
    """Factory matching TS's createMemoryRateLimitStore naming (kohaku's other create_* port factories)."""
    return MemoryRateLimitStore(max_entries)


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
        key = json.dumps(
            [params.tenant or "", params.principal or "", params.routeClass], separators=(",", ":")
        )
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
    """Builds a RateLimiter over a RateLimitStore, keying each bucket by the canonical JSON array
    [tenant, principal, routeClass] (tenant/principal default to the empty string when unset, so an
    anonymous caller still gets its own bucket per tenant/routeClass rather than colliding with every
    other anonymous caller across route classes -- the MCP profile's "no tenant, no principal" case
    still separates compose from action this way).

    Not a delimiter-joined string (e.g. f"{tenant}:{principal}:{routeClass}"): a plain colon join
    collides whenever a component itself contains the delimiter -- (tenant="a:b", principal="c") and
    (tenant="a", principal="b:c") would both join to "a:b:c:<routeClass>" and share a bucket, letting one
    caller's usage count against (or be undercounted against) another's. json.dumps(...,
    separators=(",", ":")) escapes any '"'/':'/control character inside a component, so two distinct
    triples can never encode to the same string; the separators argument drops the whitespace json.dumps
    adds by default, matching the TS port's JSON.stringify (which never adds whitespace) byte-for-byte --
    not that cross-language key equality itself matters (each language's in-process RateLimitStore never
    shares state with the other's), just that a divergent encoding isn't left as a subtle trap for a
    future shared backing store.

    Fail-open on a store error: the request is allowed through (RateLimitResult(allow=True)), and the
    error is reported via on_error (silent, fire-and-forget, if unwired -- the same notify_hook
    convention as ComposeObserver's hooks) rather than left unobserved or turned into a hard failure. A
    rate limiter outage must never itself become a reason no request can be served.
    """
    return RateLimiter(store, on_error, now)

"""In-memory ApprovalStore (port of packages/authz-hmac/src/approval-store.ts)."""

from __future__ import annotations

from collections.abc import Callable

from kohaku.spec import ApprovalStore

from .time import now_seconds

SWEEP_INTERVAL_SECONDS = 1
"""Minimum spacing, in seconds, between two full sweeps of the consumed-token map."""


class MemoryApprovalStore:
    """An in-memory ApprovalStore (jti -> expires_at). Not shared across processes or instances -- suitable
    for a single-host deployment or for tests; a multi-instance deployment should inject a shared store
    instead (mirrors `MemoryRevocationStore`'s own caveat).

    `now` is injectable (epoch seconds, defaults to the wall clock) so callers can drive expiry with a fake
    clock. Expired entries are swept opportunistically from `consume()`, at most once per
    `SWEEP_INTERVAL_SECONDS` (a full-map scan on every call would make each verification O(n) in the number of
    live consumed tokens). Throttling the sweep does not loosen the semantics: an entry that has expired but
    has not been swept yet no longer counts as consumed, so the answer for any jti is exactly what an eager
    sweep would have given.
    """

    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now: Callable[[], float] = now if now is not None else now_seconds
        self._consumed: dict[str, float] = {}
        self._last_sweep = float("-inf")

    def _sweep_expired(self, now: float) -> None:
        if now - self._last_sweep < SWEEP_INTERVAL_SECONDS:
            return
        self._last_sweep = now
        for jti in [jti for jti, expires_at in self._consumed.items() if expires_at <= now]:
            del self._consumed[jti]

    async def consume(self, jti: str, expires_at: float) -> bool:
        """Marks `jti` as consumed; returns True on first use, False if it was already consumed."""
        now = self._now()
        self._sweep_expired(now)
        previous = self._consumed.get(jti)
        if previous is not None and previous > now:
            return False
        self._consumed[jti] = expires_at
        return True


def create_memory_approval_store(now: Callable[[], float] | None = None) -> ApprovalStore:
    """Creates an in-memory ApprovalStore (TS: createMemoryApprovalStore)."""
    return MemoryApprovalStore(now)

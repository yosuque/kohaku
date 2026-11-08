"""In-memory CapabilityRevocationStore (port of packages/authz-hmac/src/revocation.ts)."""

from __future__ import annotations

from collections.abc import Callable

from kohaku.spec import CapabilityRevocationStore

from .time import now_seconds


class MemoryRevocationStore:
    """An in-memory CapabilityRevocationStore (jti -> expires_at). Not shared across processes or instances --
    suitable for a single-host deployment or for tests; a multi-instance deployment should inject a shared
    store instead.

    `now` is injectable (epoch seconds, defaults to the wall clock) so callers can drive expiry with a fake
    clock. Expired entries are swept opportunistically on `revoke()` and lazily on `is_revoked()`, so the map's
    size stays bounded by the number of issued-but-not-yet-expired revoked tokens.

    `_revoked` is the backing map; a test may inspect it directly to assert eviction (reading through
    `is_revoked` would itself delete an expired entry as a side effect, which would hide a missing sweep).
    """

    def __init__(self, now: Callable[[], float] | None = None) -> None:
        self._now: Callable[[], float] = now if now is not None else now_seconds
        self._revoked: dict[str, float] = {}

    def _sweep_expired(self) -> None:
        now = self._now()
        for jti in [jti for jti, expires_at in self._revoked.items() if expires_at <= now]:
            del self._revoked[jti]

    async def revoke(self, jti: str, expires_at: int) -> None:
        self._sweep_expired()
        self._revoked[jti] = expires_at

    async def is_revoked(self, jti: str) -> bool:
        expires_at = self._revoked.get(jti)
        if expires_at is None:
            return False
        if expires_at <= self._now():
            del self._revoked[jti]
            return False
        return True


def create_memory_revocation_store(
    now: Callable[[], float] | None = None,
) -> CapabilityRevocationStore:
    """Creates an in-memory CapabilityRevocationStore (TS: createMemoryRevocationStore)."""
    return MemoryRevocationStore(now)

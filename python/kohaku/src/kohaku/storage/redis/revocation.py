"""A Redis-backed CapabilityRevocationStore (port of packages/storage-redis/src/revocation.ts; reference adapter).

A revoked ``jti`` is a plain key carrying its own expiry (``SET ... EX``), computed from the token's ``expires_at``
minus now: once that TTL elapses, Redis drops the key itself and `is_revoked` goes back to False -- matching the
port contract's "the store may drop the entry after `expires_at`" without a separate sweep. `is_revoked` is an
EXISTS check. The key is ``{prefix}:revoked:{jti}`` (keys.py), the same one the TS store writes, so a revocation
made through one language's host is honoured by the other's.

Fail-fast: same construction and ``ready()`` gate as `create_redis_storage_port` -- see connection.py.
"""

from __future__ import annotations

import time
from typing import Any

from .connection import (
    DEFAULT_COMMAND_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    RedisConnection,
    create_redis_connection,
)
from .keys import DEFAULT_KEY_PREFIX, RedisKeys, redis_keys

try:
    from redis.asyncio import Redis
except ImportError as error:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        "kohaku.storage.redis needs the redis-py client: install it with `pip install 'kohaku-ui[redis]'`"
    ) from error


class RedisRevocationStore:
    """See the module docstring. Build one with `create_redis_revocation_store`."""

    def __init__(self, connection: RedisConnection, key_prefix: str) -> None:
        self._connection = connection
        self._redis: Any = connection.redis  # Any: see RedisStoragePort
        self._keys: RedisKeys = redis_keys(key_prefix)

    async def ready(self) -> None:
        """Resolves once the server answers; raises if it can't within `connect_timeout_ms`. A failed attempt is
        not remembered (the next call retries). Every method awaits it first."""
        await self._connection.ready()

    async def close(self) -> None:
        """Disconnects the client this store created (a no-op for an injected client)."""
        await self._connection.close()

    async def revoke(self, jti: str, expires_at: int) -> None:
        await self.ready()
        ttl_seconds = expires_at - int(time.time())
        # Already expired (or expiring this instant): the token can no longer verify anyway (its own `exp` check
        # fails first), so writing a revocation record for it would only occupy space for nothing. SET ... EX also
        # rejects a non-positive TTL outright, so this is not merely an optimization.
        if ttl_seconds <= 0:
            return
        await self._redis.set(self._keys.revoked(jti), "1", ex=ttl_seconds)

    async def is_revoked(self, jti: str) -> bool:
        await self.ready()
        return bool(await self._redis.exists(self._keys.revoked(jti)))


def create_redis_revocation_store(
    *,
    url: str | None = None,
    client: Redis | None = None,
    key_prefix: str = DEFAULT_KEY_PREFIX,
    connect_timeout_ms: int = DEFAULT_CONNECT_TIMEOUT_MS,
    command_timeout_ms: int = DEFAULT_COMMAND_TIMEOUT_MS,
) -> RedisRevocationStore:
    """Creates a Redis-backed CapabilityRevocationStore (TS: createRedisRevocationStore). Options as
    `create_redis_storage_port`; the keys are ``{key_prefix}:revoked:{jti}``."""
    connection = create_redis_connection(
        url=url,
        client=client,
        connect_timeout_ms=connect_timeout_ms,
        command_timeout_ms=command_timeout_ms,
        label="redis revocation store",
    )
    return RedisRevocationStore(connection, key_prefix)

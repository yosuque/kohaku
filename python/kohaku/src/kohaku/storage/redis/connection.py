"""The connection lifecycle shared by the Redis StoragePort and the revocation store (port of
packages/storage-redis/src/connection.ts). Both build a redis-py asyncio client (``url``-constructed or
injected) and gate every command behind the same ``ready()`` the same way, so it lives here once.

redis-py differs from ioredis in ways that remove some of the TS machinery: a client connects lazily on its first
command and raises from the command that fails (there is no unhandled ``error`` event to crash the process and no
offline queue to disable), so there is no ``onError`` hook and no ``maxRetriesPerRequest``. What stays is the
fail-fast contract: a bounded connect, a bounded per-command timeout, and a ``ready()`` that turns "Redis is
unreachable" into a bounded rejection which is *not* memoized (the next call retries).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

try:
    from redis.asyncio import Redis
except ImportError as error:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        "kohaku.storage.redis needs the redis-py client: install it with `pip install 'kohaku-ui[redis]'`"
    ) from error

DEFAULT_CONNECT_TIMEOUT_MS = 5000
"""`connect_timeout_ms`'s default: bounds the initial connection attempt (and `ready()`'s ping) so a network
partition fails fast instead of hanging."""

DEFAULT_COMMAND_TIMEOUT_MS = 5000
"""`command_timeout_ms`'s default: redis-py's `socket_timeout`, bounding every individual command of an owned
client. Without it a command sent over a half-open socket (the TCP connection looks alive but the peer never
responds) hangs forever; `connect_timeout_ms` alone does not cover it."""


@dataclass
class RedisConnection:
    """The ``ready()`` / ``close()`` lifecycle handle returned by `create_redis_connection`. The storage port and the
    revocation store build their own keys and commands against `.redis` and delegate connection management here."""

    redis: Redis
    """The client to issue commands against (owned or injected)."""
    owned: bool
    """Whether this handle created `redis` itself (as opposed to reusing an injected client)."""
    label: str
    connect_timeout_ms: int
    _ready_ok: bool = field(default=False, init=False, repr=False)
    _ready_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    async def ready(self) -> None:
        """Resolves once the server answers a PING; raises (``RuntimeError("<label> is not ready: ...")``) if it
        does not within `connect_timeout_ms`. A success is remembered; a failure is not, so a transient outage
        (Redis briefly unreachable, a restart mid-deploy) does not permanently strand this handle."""
        if self._ready_ok:
            return
        async with self._ready_lock:
            if self._ready_ok:
                return
            try:
                await asyncio.wait_for(
                    self.redis.ping(),
                    timeout=self.connect_timeout_ms / 1000,
                )
            except Exception as error:
                raise RuntimeError(f"{self.label} is not ready: {error}") from error
            self._ready_ok = True

    async def close(self) -> None:
        """Ends `redis` if (and only if) this handle created it; a no-op for an injected client (its owner
        closes it)."""
        if self.owned:
            await self.redis.aclose()


def create_redis_connection(
    *,
    url: str | None = None,
    client: Redis | None = None,
    connect_timeout_ms: int = DEFAULT_CONNECT_TIMEOUT_MS,
    command_timeout_ms: int = DEFAULT_COMMAND_TIMEOUT_MS,
    label: str = "redis",
) -> RedisConnection:
    """Builds (or adopts) a redis-py asyncio client and its lifecycle. ``label`` identifies the caller in
    validation and "not ready" messages (e.g. "redis storage port").

    An owned client is created with ``decode_responses=True`` (the adapters read and write JSON text), a bounded
    connect and a bounded per-command timeout. An injected ``client`` is never reconfigured, but it MUST have been
    created with ``decode_responses=True`` -- the adapters compare and parse text, and bytes replies would fail in
    ways that look like data corruption -- so that is checked up front.
    """
    if client is not None and url is not None:
        raise ValueError(f"{label}: pass either `url` or `client`, not both")
    if client is None and url is None:
        raise ValueError(f"{label}: one of `url` or `client` is required")

    if client is not None:
        kwargs: dict[str, Any] = client.connection_pool.connection_kwargs
        if kwargs.get("decode_responses") is not True:
            raise ValueError(
                f"{label}: the injected redis client must be created with decode_responses=True"
            )
        return RedisConnection(
            redis=client, owned=False, label=label, connect_timeout_ms=connect_timeout_ms
        )

    assert url is not None
    owned_client: Redis = Redis.from_url(
        url,
        decode_responses=True,
        socket_connect_timeout=connect_timeout_ms / 1000,
        socket_timeout=command_timeout_ms / 1000,
    )
    return RedisConnection(
        redis=owned_client, owned=True, label=label, connect_timeout_ms=connect_timeout_ms
    )

"""Environment-driven selection of the sample's StoragePort and revocation store (equivalent to the storage half of
apps/sample-api/src/ports/from-env.ts; docs/specification.md section 9). Everything here is sample wiring: a product
picks its adapters in code.

Environment variables (the same names as the TS sample-api):

- ``KOHAKU_STORAGE``: ``file`` (default) / ``memory`` / ``redis`` / ``postgres``.
- ``KOHAKU_REDIS_URL`` (required for ``redis``) and ``KOHAKU_STORAGE_KEY_PREFIX`` (optional key prefix).
- ``KOHAKU_POSTGRES_URL`` (required for ``postgres``) and ``KOHAKU_POSTGRES_SCHEMA`` (optional schema).

The revocation store follows the storage selection, not the authz one: a multi-instance deployment needs a shared
store regardless of how tokens are issued, and it needs to survive a restart the same way the Spec cache does.
``file`` and ``memory`` get the in-memory store -- fine for a single instance. One backend connection is shared by the
storage port and the revocation store (TS: design.md #48).

A redis-py client and a psycopg pool belong to the event loop that first uses them, so `create_storage_from_env` only
builds objects (it opens nothing); the host must call it, `ready()` and everything that uses the ports inside the one
loop it serves from.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from kohaku.authz_hmac import create_memory_revocation_store
from kohaku.spec import CapabilityRevocationStore, StoragePort
from kohaku.storage import FileStoragePort, MemoryStoragePort

StorageKind = Literal["file", "memory", "redis", "postgres"]

_STORAGE_KINDS: tuple[StorageKind, ...] = ("file", "memory", "redis", "postgres")


@dataclass
class StorageFromEnv:
    kind: StorageKind
    storage: StoragePort
    revocations: CapabilityRevocationStore
    ready: Callable[[], Awaitable[None]]
    """Resolves once the backend is reachable and migrated (a no-op for file / memory), so a host fails fast at
    startup instead of discovering an unreachable backend on the first request."""
    close: Callable[[], Awaitable[None]]
    """Releases the backend connection this created (a no-op for file / memory)."""


async def _noop() -> None:
    return None


def storage_kind_from_env(env: Mapping[str, str]) -> StorageKind:
    """Validates and returns ``KOHAKU_STORAGE`` (default "file"). The single place this env var is parsed."""
    kind = env.get("KOHAKU_STORAGE", "file")
    if kind not in _STORAGE_KINDS:
        raise ValueError(
            f'KOHAKU_STORAGE must be one of {" / ".join(_STORAGE_KINDS)}, got "{kind}"'
        )
    return kind


def _required(env: Mapping[str, str], name: str, for_kind: str) -> str:
    value = env.get(name, "")
    if value == "":
        raise ValueError(f"{name} is required when KOHAKU_STORAGE={for_kind}")
    return value


def create_storage_from_env(env: Mapping[str, str], *, data_dir: str | Path) -> StorageFromEnv:
    kind = storage_kind_from_env(env)
    if kind == "file":
        return StorageFromEnv(
            kind, FileStoragePort(data_dir), create_memory_revocation_store(), _noop, _noop
        )
    if kind == "memory":
        return StorageFromEnv(
            kind, MemoryStoragePort(), create_memory_revocation_store(), _noop, _noop
        )

    if kind == "redis":
        # Lazy import: the redis-py client is the "redis" extra, needed only when this backend is selected.
        from kohaku.storage.redis import (
            create_redis_connection,
            create_redis_revocation_store,
            create_redis_storage_port,
        )

        url = _required(env, "KOHAKU_REDIS_URL", kind)
        key_prefix = env.get("KOHAKU_STORAGE_KEY_PREFIX") or "kohaku"
        connection = create_redis_connection(url=url, label="redis")
        redis_storage = create_redis_storage_port(client=connection.redis, key_prefix=key_prefix)
        redis_revocations = create_redis_revocation_store(
            client=connection.redis, key_prefix=key_prefix
        )

        async def redis_ready() -> None:
            await redis_storage.ready()
            await redis_revocations.ready()

        return StorageFromEnv(kind, redis_storage, redis_revocations, redis_ready, connection.close)

    from kohaku.storage.postgres import (
        create_postgres_pool,
        create_postgres_revocation_store,
        create_postgres_storage_port,
    )

    url = _required(env, "KOHAKU_POSTGRES_URL", kind)
    schema = env.get("KOHAKU_POSTGRES_SCHEMA") or "public"
    handle = create_postgres_pool(connection_string=url, schema=schema)
    pg_storage = create_postgres_storage_port(pool=handle.pool, schema=schema)
    pg_revocations = create_postgres_revocation_store(pool=handle.pool, schema=schema)

    async def pg_ready() -> None:
        await pg_storage.ready()
        await pg_revocations.ready()

    return StorageFromEnv(kind, pg_storage, pg_revocations, pg_ready, handle.close)

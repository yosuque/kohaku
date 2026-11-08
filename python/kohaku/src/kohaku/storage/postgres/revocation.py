"""A PostgreSQL-backed CapabilityRevocationStore (port of packages/storage-postgres/src/revocation.ts; reference
adapter).

One row per revoked ``jti``, keyed by ``jti`` itself, with its own ``expires_at``; unlike the Redis store's TTL-keyed
entry, an expired row is not dropped automatically -- `is_revoked` filters it out on read (``expires_at > now()``),
and `sweep_expired_revocations()` (meant for a cron, same treatment as the storage port's
`sweep_expired_spec_cache()`) deletes it. The table is ``kohaku_capability_revocation`` -- the one the TS store
writes -- so a revocation made through one language's host is honoured by the other's. Connection lifecycle
(timeouts, the versioned migration) is shared with the storage port through connection.py.
"""

from __future__ import annotations

from typing import Any

from .connection import PostgresPoolHandle, create_postgres_pool
from .schema import DEFAULT_SCHEMA, escape_placeholders, qualified_table

try:
    from psycopg import AsyncConnection
    from psycopg_pool import AsyncConnectionPool
except ImportError as error:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        "kohaku.storage.postgres needs psycopg 3 and its pool: install them with "
        "`pip install 'kohaku-ui[postgres]'` (plus `psycopg[binary]` unless libpq is installed)"
    ) from error


class PostgresRevocationStore:
    """See the module docstring. Build one with `create_postgres_revocation_store`."""

    def __init__(self, db: PostgresPoolHandle) -> None:
        self._db = db
        # Every statement here runs with parameters, so a `%` in the schema name must be escaped (see escape_placeholders).
        self._table = escape_placeholders(
            qualified_table(db.schema, "kohaku_capability_revocation")
        )

    async def ready(self) -> None:
        """Resolves once the pool is open and the schema is in place."""
        await self._db.ready()

    async def close(self) -> None:
        """Ends the pool this store created (a no-op for an injected pool)."""
        await self._db.close()

    async def revoke(self, jti: str, expires_at: int) -> None:
        await self.ready()
        await self._db.query(
            f"INSERT INTO {self._table} (jti, expires_at) VALUES (%s, to_timestamp(%s::double precision)) "
            f"ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at",
            [jti, expires_at],
        )

    async def is_revoked(self, jti: str) -> bool:
        await self.ready()
        result = await self._db.query(
            f"SELECT 1 FROM {self._table} WHERE jti = %s AND expires_at > now()", [jti]
        )
        return len(result.rows) > 0

    async def sweep_expired_revocations(self) -> int:
        """Deletes expired revocation rows (`is_revoked` already treats them as not-revoked); returns the row count.
        For a cron."""
        await self.ready()
        result = await self._db.query(f"DELETE FROM {self._table} WHERE expires_at <= now()")
        return result.rowcount


def create_postgres_revocation_store(
    *,
    connection_string: str | None = None,
    pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]] | None = None,
    schema: str = DEFAULT_SCHEMA,
    migrate: bool = True,
    connect_timeout_ms: int | None = None,
    statement_timeout_ms: int | None = None,
    max_connections: int | None = None,
) -> PostgresRevocationStore:
    """Creates a PostgreSQL-backed CapabilityRevocationStore (TS: createPostgresRevocationStore). Options as
    `create_postgres_pool`."""
    options: dict[str, Any] = {}
    if connect_timeout_ms is not None:
        options["connect_timeout_ms"] = connect_timeout_ms
    if statement_timeout_ms is not None:
        options["statement_timeout_ms"] = statement_timeout_ms
    handle = create_postgres_pool(
        connection_string=connection_string,
        pool=pool,
        schema=schema,
        migrate=migrate,
        max_connections=max_connections,
        **options,
    )
    return PostgresRevocationStore(handle)

"""The pool lifecycle shared by the Postgres StoragePort and the revocation store (port of
packages/storage-postgres/src/connection.ts): option validation, pool construction for an owned pool, and the
memoised, advisory-lock-guarded ``ready()`` migration with schema-version enforcement.

The migration protocol is identical to the TS adapter's -- the same advisory lock key (``kohaku:schema:{schema}``,
through ``hashtext``), the same transaction, the same ``CREATE INDEX CONCURRENTLY`` afterwards -- so a TS host and a
Python host starting at the same time serialize against each other rather than racing on the DDL.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, cast

try:
    from psycopg import AsyncConnection
    from psycopg import errors as pg_errors
    from psycopg_pool import AsyncConnectionPool
except ImportError as error:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        "kohaku.storage.postgres needs psycopg 3 and its pool: install them with "
        "`pip install 'kohaku-ui[postgres]'` (plus `psycopg[binary]` unless libpq is installed)"
    ) from error

from .schema import (
    DEFAULT_SCHEMA,
    POSTGRES_SCHEMA_VERSION,
    escape_placeholders,
    lineage_correlation_ddl,
    postgres_base_schema_sql,
    qualified_table,
    quote_identifier,
)

DEFAULT_CONNECT_TIMEOUT_MS = 5000
"""`connect_timeout_ms`'s default: libpq's own default is to wait forever, which turns a network partition into a
hang instead of a clear, timely error."""

DEFAULT_STATEMENT_TIMEOUT_MS = 10000
"""`statement_timeout_ms`'s default: bounds a single runaway query (a lock wait, a full-table scan against an
un-migrated database) instead of letting it hold a pool connection indefinitely."""

DEFAULT_MAX_CONNECTIONS = 10
"""`max_connections`'s default: node-postgres' own `max` default, which the TS adapter inherits."""

RETRYABLE_DDL_SQLSTATES = frozenset({"23505", "42P07"})
"""SQLSTATEs a concurrent-DDL race can surface even while holding the advisory lock (e.g. a second process's
transaction started, and validated the catalog, just before the first process committed its own DDL) --
see `_migrate_schema`'s retry-once."""

MIGRATION_LOCK_TIMEOUT_MS = 5000
"""``lock_timeout`` for the migration transaction: a `ready()` that cannot get a table lock quickly (a long-running
lineage query holds a conflicting one) fails fast instead of queueing behind it -- a queued ACCESS EXCLUSIVE / SHARE
request blocks every later reader and writer of the table."""

READY_RETRY_INITIAL_DELAY_MS = 1000
"""First wait after a failed `ready()` before the migration is attempted again; doubles per consecutive failure."""

READY_RETRY_MAX_DELAY_MS = 60000
"""Ceiling of the `ready()` retry backoff."""

MIGRATION_LOCK_POLL_MS = 250
"""How often a migrator waiting for another one re-tries the migration lock."""

MIGRATION_LOCK_WAIT_MS = 60000
"""How long a migrator waits for the migration advisory lock before `ready()` rejects. Another instance can hold the
lock for a long time (a CREATE INDEX CONCURRENTLY over a large lineage table) or indefinitely (a hung process whose
session stays open); without a bound the waiter would hang silently before the host starts listening."""


def sql_text(text: str) -> Any:
    """psycopg types a query as `LiteralString` to discourage building SQL from strings. Every statement in this
    package is built from identifiers quoted by `quote_identifier` and from bound parameters -- never from a value --
    so the check is bypassed here, in one place, rather than with a suppression at every call."""
    return cast("Any", text)


def _backoff_clock() -> float:
    """The clock the `ready()` retry backoff reads (monotonic seconds); a separate function so a test can drive the
    backoff window without touching the process-wide `time.monotonic` the event loop itself depends on."""
    return time.monotonic()


@dataclass(frozen=True)
class QueryResult:
    rows: list[tuple[Any, ...]]
    rowcount: int


class PostgresPoolHandle:
    """The pool, its ``ready()`` / ``close()`` lifecycle and the one place statements are executed. Both adapters
    build their own table-specific SQL and run it through `query`."""

    def __init__(
        self,
        pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]],
        *,
        owned: bool,
        schema: str,
        migrate: bool,
        connect_timeout_ms: int,
    ) -> None:
        self.pool = pool
        self.owned = owned
        self.schema = schema
        self.migrate = migrate
        self._connect_timeout_ms = connect_timeout_ms
        self._opened = False
        self._ready_done = False
        self._ready_lock = asyncio.Lock()
        self._failure: tuple[Exception, int, float] | None = None
        """The last migration failure as (error, delay_ms, retry_at monotonic seconds)."""

    async def _open(self) -> None:
        """Starts the pool's connections (an owned pool is created closed, so no connection is attempted outside
        an event loop). Idempotent, and for an injected pool the caller's own lifecycle wins."""
        if self._opened:
            return
        if self.pool.closed:
            await self.pool.open(wait=True, timeout=self._connect_timeout_ms / 1000)
        self._opened = True

    async def ready(self) -> None:
        """Resolves once the pool is open and the schema is in place (immediately after opening when
        ``migrate=False``). Memoised. A failed migration is not cached, but retries back off (1 s doubling to 60 s):
        a call inside the backoff window raises the last error without touching the database."""
        if self._ready_done:
            return
        async with self._ready_lock:
            if self._ready_done:
                return
            await self._open()
            if not self.migrate:
                self._ready_done = True
                return
            # Inside the backoff window: hand back the last error instead of re-running a migration that just
            # failed -- every StoragePort method awaits `ready()`, so without this a persistent failure (a slow
            # index build, a lock held by live traffic) would re-run the DDL on every request.
            if self._failure is not None and _backoff_clock() < self._failure[2]:
                raise self._failure[0]
            try:
                await _migrate_schema(self.pool, self.schema)
            except Exception as error:
                # Don't memoize a failed migration: a transient error (a network blip, a lock-wait timeout) would
                # otherwise permanently strand this handle with no retry path.
                delay_ms = (
                    READY_RETRY_INITIAL_DELAY_MS
                    if self._failure is None
                    else min(self._failure[1] * 2, READY_RETRY_MAX_DELAY_MS)
                )
                self._failure = (error, delay_ms, _backoff_clock() + delay_ms / 1000)
                raise
            self._failure = None
            self._ready_done = True

    async def close(self) -> None:
        """Ends the pool if (and only if) this handle created it."""
        if self.owned:
            await self.pool.close()

    async def query(
        self, sql: str, params: Sequence[Any] | dict[str, Any] | None = None
    ) -> QueryResult:
        """Runs one statement on a pooled connection and returns its rows (empty for a statement that returns
        none) and row count. The pool's connections are autocommit, so a statement is its own transaction."""
        async with self.pool.connection() as conn:
            # Always pass a parameter list (possibly empty): psycopg then reads `%%` as an escaped percent in every
            # statement, which is what lets the table identifiers be embedded `%`-escaped (schema.escape_placeholders).
            cursor = await conn.execute(sql_text(sql), params if params is not None else [])
            rows = await cursor.fetchall() if cursor.description is not None else []
            return QueryResult(rows=rows, rowcount=cursor.rowcount)


def create_postgres_pool(
    *,
    connection_string: str | None = None,
    pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]] | None = None,
    schema: str = DEFAULT_SCHEMA,
    migrate: bool = True,
    connect_timeout_ms: int = DEFAULT_CONNECT_TIMEOUT_MS,
    statement_timeout_ms: int = DEFAULT_STATEMENT_TIMEOUT_MS,
    max_connections: int | None = None,
) -> PostgresPoolHandle:
    """Validates the options and builds (or adopts) the pool.

    ``connection_string``: a libpq connection string or URL; mutually exclusive with ``pool``. ``pool``: an existing
    ``psycopg_pool.AsyncConnectionPool`` to share -- `close()` then does not end it, and its connections should be
    autocommit (the adapters issue single statements; a non-autocommit pool still works, each statement then runs in
    a transaction the pool commits on release). ``schema``: default "public", created with ``CREATE SCHEMA IF NOT
    EXISTS`` when migrating. ``migrate``: run the idempotent DDL once before the first query (default True); with
    ``False`` the schema is yours, and the storage port still checks read-only that ``kohaku_lineage`` has the
    ``correlation_id`` column. ``connect_timeout_ms`` / ``statement_timeout_ms`` / ``max_connections`` apply to an
    owned pool only; the statement timeout is sent as a startup parameter, so PostgreSQL enforces it server-side on
    every connection the pool opens.
    """
    if pool is not None and connection_string is not None:
        raise ValueError(
            "create_postgres_pool: pass either `connection_string` or `pool`, not both"
        )
    if pool is None and connection_string is None:
        raise ValueError("create_postgres_pool: one of `connection_string` or `pool` is required")

    if pool is not None:
        return PostgresPoolHandle(
            pool,
            owned=False,
            schema=schema,
            migrate=migrate,
            connect_timeout_ms=connect_timeout_ms,
        )

    assert connection_string is not None
    owned_pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]] = AsyncConnectionPool(
        connection_string,
        kwargs={
            "autocommit": True,
            "connect_timeout": max(1, round(connect_timeout_ms / 1000)),
            "options": f"-c statement_timeout={statement_timeout_ms}",
        },
        min_size=1,
        max_size=max_connections if max_connections is not None else DEFAULT_MAX_CONNECTIONS,
        timeout=connect_timeout_ms / 1000,
        open=False,
    )
    return PostgresPoolHandle(
        owned_pool,
        owned=True,
        schema=schema,
        migrate=migrate,
        connect_timeout_ms=connect_timeout_ms,
    )


async def _migrate_schema(
    pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]], schema: str
) -> None:
    """The whole `ready()` sequence -- the idempotent DDL transaction, then the correlation index build -- on one
    dedicated connection, serialized against every other migrator (this process's other callers, and other
    processes/instances, in either language) by a session-level advisory lock keyed by `schema`. ``CREATE TABLE IF
    NOT EXISTS`` alone is not safe under concurrent first-run migration (two instances can both pass the "does it
    exist" check before either commits, and race on the same DDL).

    One lock covers both steps on purpose. The index build (``CREATE INDEX CONCURRENTLY``) waits for every older
    transaction to finish, and a second migrator's transaction that is itself waiting for a table lock behind that
    build would never finish: a deadlock. Holding the lock across the transaction and the build, and acquiring it by
    polling outside any transaction (`_acquire_session_lock`), means a waiting migrator has no open transaction or
    running statement for the build to wait on.

    Also enforces ``kohaku_schema_meta``: inserts `POSTGRES_SCHEMA_VERSION` on an empty table, raises if a deployed
    schema already carries a different version.
    """
    lock_key = f"kohaku:schema:{schema}"
    async with pool.connection() as conn:
        previous_autocommit = conn.autocommit
        # The advisory lock is polled outside any transaction and CREATE INDEX CONCURRENTLY cannot run inside one,
        # so the whole sequence needs autocommit (an injected pool may hand out a non-autocommit connection).
        await conn.set_autocommit(True)
        discard = False
        try:
            await _acquire_session_lock(conn, lock_key)
            try:
                try:
                    await _run_migration(conn, schema)
                except pg_errors.Error as error:
                    if error.sqlstate not in RETRYABLE_DDL_SQLSTATES:
                        raise
                    # A concurrent-DDL race can still surface here even under the advisory lock (e.g. a
                    # transaction that read the catalog just before a concurrent migrator committed) -- retry once
                    # rather than failing the whole process's first `ready()` on a one-off race.
                    await _run_migration(conn, schema)
                await _ensure_correlation_index(conn, schema)
            finally:
                try:
                    await conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", [lock_key])
                except Exception:
                    discard = True
        finally:
            # The session settings must not leak into the pool: restore them, or drop the connection.
            try:
                await conn.execute("RESET statement_timeout")
                await conn.set_autocommit(previous_autocommit)
            except Exception:
                discard = True
            if discard:
                await conn.close()


async def _run_migration(conn: AsyncConnection[tuple[Any, ...]], schema: str) -> None:
    # Waiting for another migrator happens before this transaction (`_acquire_session_lock`); the timeout below is
    # for table locks behind live traffic, which must not queue. SET LOCAL reverts at COMMIT/ROLLBACK, so it never
    # leaks into the pool.
    async with conn.transaction():
        await conn.execute(sql_text(f"SET LOCAL lock_timeout = {MIGRATION_LOCK_TIMEOUT_MS}"))
        await conn.execute(sql_text(f"CREATE SCHEMA IF NOT EXISTS {quote_identifier(schema)}"))
        await conn.execute(sql_text(postgres_base_schema_sql(schema)))
        await _migrate_lineage_correlation_column(conn, schema)
        await _ensure_schema_version(conn, schema)


async def _migrate_lineage_correlation_column(
    conn: AsyncConnection[tuple[Any, ...]], schema: str
) -> None:
    """Adds ``kohaku_lineage.correlation_id`` only when the catalog says it is missing (see
    `lineage_correlation_ddl` for why the ``IF NOT EXISTS`` form alone is not enough): on an up-to-date database a
    start takes no lock on the lineage table beyond what the base script's own ``CREATE INDEX IF NOT EXISTS``
    statements need. The column's index is not created here: it is built after this transaction commits."""
    _, has_column = await _lineage_correlation_catalog(conn, schema)
    if not has_column:
        await conn.execute(sql_text(lineage_correlation_ddl(schema).add_column_sql))


async def _lineage_correlation_catalog(
    conn: AsyncConnection[tuple[Any, ...]], schema: str
) -> tuple[bool, bool]:
    """Whether ``kohaku_lineage`` exists in `schema` and, if so, whether it already has ``correlation_id``."""
    cursor = await conn.execute(
        """SELECT rel.oid IS NOT NULL AS has_table,
            EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = rel.oid AND a.attname = %s AND a.attnum > 0 AND NOT a.attisdropped) AS has_column
       FROM (SELECT to_regclass(%s) AS oid) rel""",
        [lineage_correlation_ddl(schema).column_name, qualified_table(schema, "kohaku_lineage")],
    )
    row = await cursor.fetchone()
    return (row is not None and row[0] is True, row is not None and row[1] is True)


async def assert_lineage_schema_current(
    pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]], schema: str
) -> None:
    """The ``migrate=False`` counterpart of the migration: a read-only check that ``kohaku_lineage`` carries the
    ``correlation_id`` column, because `append_lineage` writes it on every call. Without it every INSERT fails with
    42703, and since lineage recording is fail-open the audit events would be lost silently. A schema with no
    ``kohaku_lineage`` table at all passes (a deployment that never uses lineage; the first query against the
    missing table fails on its own)."""
    async with pool.connection() as conn:
        has_table, has_column = await _lineage_correlation_catalog(conn, schema)
    if not has_table or has_column:
        return
    ddl = lineage_correlation_ddl(schema)
    raise RuntimeError(
        f"kohaku.storage.postgres: {qualified_table(schema, 'kohaku_lineage')} has no {ddl.column_name} column "
        f"(added in 0.4.0), so every append_lineage would fail and lineage events would be lost. With "
        f"migrate=False the schema is yours to upgrade: run `{ddl.add_column_sql}` (and optionally "
        f"`{ddl.create_index_concurrently_sql}`) before deploying this version. See the @kohaku-ui/storage-postgres "
        f'README, "Upgrading to 0.4.x".'
    )


async def _correlation_index_state(
    conn: AsyncConnection[tuple[Any, ...]], schema: str, index_name: str
) -> str:
    """``valid``, ``invalid`` (a failed ``CREATE INDEX CONCURRENTLY`` leaves one behind) or ``missing``. Resolved
    through the catalog by name (``to_regclass``) rather than matching ``pg_indexes.indexname``: that matches an
    INVALID index as present, and PostgreSQL truncates a long identifier so the name written in the DDL text would
    not equal the stored one."""
    cursor = await conn.execute(
        "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(%s)",
        [qualified_table(schema, index_name)],
    )
    row = await cursor.fetchone()
    if row is None:
        return "missing"
    return "valid" if row[0] is True else "invalid"


async def _acquire_session_lock(conn: AsyncConnection[tuple[Any, ...]], key: str) -> None:
    """Takes a session-level advisory lock by polling ``pg_try_advisory_lock``. A blocking ``pg_advisory_lock`` would
    leave the waiter inside a running statement while the holder's ``CREATE INDEX CONCURRENTLY`` waits for every
    older transaction to finish: a deadlock. Each try is a statement of its own. The wait is bounded by
    `MIGRATION_LOCK_WAIT_MS`: once that much time has passed without getting the lock it raises, naming the lock key
    and the elapsed time, instead of polling forever."""
    started_at = time.monotonic()
    while True:
        cursor = await conn.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS locked", [key])
        row = await cursor.fetchone()
        if row is not None and row[0] is True:
            return
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        if elapsed_ms >= MIGRATION_LOCK_WAIT_MS:
            raise RuntimeError(
                f"kohaku.storage.postgres: timed out after {elapsed_ms} ms waiting for the migration advisory lock "
                f"\"{key}\" (pg_try_advisory_lock(hashtext('{key}'))). Another instance holds it -- a slow "
                f"CREATE INDEX CONCURRENTLY or a hung migrator. Check pg_locks (locktype = 'advisory') and "
                f"pg_stat_activity for the holder, or run the migration yourself and start with migrate=False."
            )
        await asyncio.sleep(MIGRATION_LOCK_POLL_MS / 1000)


async def _ensure_correlation_index(conn: AsyncConnection[tuple[Any, ...]], schema: str) -> None:
    """Makes sure the ``(correlation_id, seq)`` index exists and is valid, outside any transaction (``CREATE INDEX
    CONCURRENTLY`` cannot run in one, and unlike a plain ``CREATE INDEX`` it does not block inserts while it builds).
    Runs with ``statement_timeout = 0`` (restored by the caller): the owned pool's default (10 s) is far shorter than a
    build over a large lineage table, and a timed-out build would be rolled back and restarted forever. The caller
    holds the migration lock. An INVALID index left by an earlier failed build is dropped and rebuilt. Up to date: one
    catalog read, no DDL."""
    ddl = lineage_correlation_ddl(schema)
    state = await _correlation_index_state(conn, schema, ddl.index_name)
    if state == "valid":
        return
    await conn.execute("SET statement_timeout = 0")
    if state == "invalid":
        await conn.execute(sql_text(ddl.drop_index_concurrently_sql))
    await conn.execute(sql_text(ddl.create_index_concurrently_sql))


async def _ensure_schema_version(conn: AsyncConnection[tuple[Any, ...]], schema: str) -> None:
    table = qualified_table(schema, "kohaku_schema_meta")
    cursor = await conn.execute(sql_text(f"SELECT version FROM {table} WHERE id = 1"))
    row = await cursor.fetchone()
    if row is None:
        # Stamping a schema as version 1 for the first time: this is exactly the case where an existing,
        # pre-versioning deployment gets a free pass with no row to compare against. CREATE TABLE IF NOT EXISTS (run
        # just before this, in the same transaction) does not retrofit UNIQUE (id) onto an already-existing
        # kohaku_lineage table, and without it the first append_lineage's ON CONFLICT (id) DO NOTHING fails at runtime
        # with "no unique or exclusion constraint matching the ON CONFLICT specification" -- so check for it here,
        # once, while stamping, rather than let that surface later as an opaque runtime error.
        await _assert_lineage_id_is_unique(conn, schema)
        await conn.execute(
            sql_text(f"INSERT INTO {escape_placeholders(table)} (id, version) VALUES (1, %s)"),
            [POSTGRES_SCHEMA_VERSION],
        )
        return
    found = row[0]
    if found != POSTGRES_SCHEMA_VERSION:
        raise RuntimeError(
            f'kohaku.storage.postgres: schema "{schema}" is at kohaku_schema_meta.version {found}, '
            f"but this package expects version {POSTGRES_SCHEMA_VERSION}. See the @kohaku-ui/storage-postgres "
            f'README, "Migrating from a pre-release schema", before upgrading a deployed database.'
        )


async def _assert_lineage_id_is_unique(conn: AsyncConnection[tuple[Any, ...]], schema: str) -> None:
    """Verifies a unique index/constraint on exactly ``kohaku_lineage.id`` exists (a fresh install's own CREATE TABLE
    already declares ``UNIQUE (id)``, so this is a no-op there; it only ever fires for a pre-existing table that
    predates this package's schema-versioning support). Checks ``pg_index`` directly rather than
    ``information_schema`` so a plain unique index (not only a named UNIQUE table constraint) also satisfies it,
    matching what ``ON CONFLICT (id)`` needs."""
    cursor = await conn.execute(
        """SELECT true AS ok
       FROM pg_index i
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = %s
        AND t.relname = 'kohaku_lineage'
        AND i.indisunique
        AND i.indnatts = 1
        AND a.attname = 'id'
      LIMIT 1""",
        [schema],
    )
    if await cursor.fetchone() is None:
        raise RuntimeError(
            f'kohaku.storage.postgres: schema "{schema}" has a kohaku_lineage table with no unique '
            f'constraint/index on "id". This package\'s append_lineage relies on ON CONFLICT (id) DO NOTHING, '
            f'which requires one. See the @kohaku-ui/storage-postgres README, "Migrating from a pre-release schema", '
            f"step 2 (ALTER TABLE kohaku_lineage ADD CONSTRAINT kohaku_lineage_id_key UNIQUE (id)), before the first "
            f"append_lineage call."
        )

"""Tests for kohaku.storage.postgres.connection (port of packages/storage-postgres/test/connection.test.ts): option
validation, pool construction, the `ready()` retry backoff and the advisory-lock-guarded migration, against a fake
connection that records the statements it is given -- so the exact DDL ordering (lock before BEGIN, column inside the
transaction, index build after COMMIT) is pinned without a database. The same migration runs against a real Postgres in
test_postgres_storage.py.

The TS tests of node-postgres-specific machinery (the pool `error` listener / `onError`) have no counterpart:
psycopg_pool reports a failing background connection through its own logging and raises from the `getconn`/query that
needs it, rather than emitting an event that crashes the process when unhandled.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, cast

import pytest
from psycopg import errors as pg_errors

from kohaku.storage.postgres import connection as connection_module
from kohaku.storage.postgres import create_postgres_pool, lineage_correlation_ddl


def run(coro: Any) -> None:
    asyncio.run(coro)


class TestOptionValidation:
    def test_rejects_passing_both_a_connection_string_and_a_pool(self) -> None:
        with pytest.raises(ValueError, match="pass either `connection_string` or `pool`, not both"):
            create_postgres_pool(connection_string="postgresql://x", pool=SimpleNamespace())  # type: ignore[arg-type]

    def test_rejects_passing_neither(self) -> None:
        with pytest.raises(ValueError, match="one of `connection_string` or `pool` is required"):
            create_postgres_pool()


class TestOwnedPoolConstruction:
    def test_passes_the_timeouts_and_max_through_to_the_pool(self) -> None:
        handle = create_postgres_pool(
            connection_string="postgresql://example/db",
            connect_timeout_ms=4000,
            statement_timeout_ms=7000,
            max_connections=4,
        )
        assert handle.owned is True
        assert handle.pool.max_size == 4
        assert cast(dict[str, Any], handle.pool.kwargs)["connect_timeout"] == 4
        assert cast(dict[str, Any], handle.pool.kwargs)["options"] == "-c statement_timeout=7000"
        assert cast(dict[str, Any], handle.pool.kwargs)["autocommit"] is True
        assert (
            handle.pool.closed
        )  # opened by ready(), not by construction: no connection outside a loop

    def test_applies_the_documented_defaults_when_timeouts_and_max_are_omitted(self) -> None:
        handle = create_postgres_pool(connection_string="postgresql://example/db")
        assert handle.pool.max_size == 10
        assert cast(dict[str, Any], handle.pool.kwargs)["connect_timeout"] == 5
        assert cast(dict[str, Any], handle.pool.kwargs)["options"] == "-c statement_timeout=10000"

    def test_never_ends_an_injected_pool(self) -> None:
        async def go() -> None:
            closed: list[bool] = []

            async def close() -> None:
                closed.append(True)

            injected = SimpleNamespace(closed=False, close=close)
            handle = create_postgres_pool(pool=injected)  # type: ignore[arg-type]
            assert handle.owned is False
            await handle.close()
            assert closed == []

        run(go())

    def test_close_ends_an_owned_pool(self) -> None:
        async def go() -> None:
            handle = create_postgres_pool(connection_string="postgresql://example/db")
            closed: list[bool] = []

            async def close() -> None:
                closed.append(True)

            cast(Any, handle.pool).close = close
            await handle.close()
            assert closed == [True]

        run(go())


def _handle_with_migration(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[Exception | None]
) -> tuple[connection_module.PostgresPoolHandle, list[int], list[float]]:
    """A handle on a stand-in pool whose migration follows `outcomes` (an Exception = fail, None = succeed), and
    a settable backoff clock."""
    calls: list[int] = []
    clock = [1000.0]

    async def fake_migrate(pool: object, schema: str) -> None:
        calls.append(1)
        outcome = outcomes[len(calls) - 1]
        if outcome is not None:
            raise outcome

    monkeypatch.setattr(connection_module, "_migrate_schema", fake_migrate)
    monkeypatch.setattr(connection_module, "_backoff_clock", lambda: clock[0])
    handle = create_postgres_pool(pool=SimpleNamespace(closed=False))  # type: ignore[arg-type]
    return handle, calls, clock


class TestReadyBackoff:
    def test_does_not_cache_a_rejected_migration_a_later_call_retries_from_scratch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def go() -> None:
            handle, calls, clock = _handle_with_migration(monkeypatch, [RuntimeError("blip"), None])
            with pytest.raises(RuntimeError, match="blip"):
                await handle.ready()
            clock[0] += 1.1  # past the first 1 s backoff window
            await handle.ready()
            await handle.ready()  # memoised after the success
            assert len(calls) == 2

        run(go())

    def test_rejects_calls_inside_the_backoff_window_with_the_last_error_without_touching_the_database(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def go() -> None:
            handle, calls, _ = _handle_with_migration(monkeypatch, [RuntimeError("first"), None])
            with pytest.raises(RuntimeError, match="first"):
                await handle.ready()
            with pytest.raises(RuntimeError, match="first"):
                await handle.ready()
            assert len(calls) == 1

        run(go())

    def test_doubles_the_wait_per_consecutive_failure_up_to_60_seconds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def go() -> None:
            handle, calls, clock = _handle_with_migration(
                monkeypatch, [RuntimeError(f"fail {i}") for i in range(8)] + [None]
            )
            for expected_delay_s in (1, 2, 4, 8, 16, 32, 60, 60):
                with pytest.raises(RuntimeError):
                    await handle.ready()
                before = len(calls)
                clock[0] += expected_delay_s - 0.5
                with pytest.raises(RuntimeError):  # still inside the window: no new attempt
                    await handle.ready()
                assert len(calls) == before
                clock[0] += 0.6
            await handle.ready()

        run(go())

    def test_resets_the_backoff_once_a_migration_succeeds(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def go() -> None:
            handle, calls, clock = _handle_with_migration(
                monkeypatch, [RuntimeError("a"), RuntimeError("b"), None]
            )
            with pytest.raises(RuntimeError):
                await handle.ready()
            clock[0] += 1.1
            with pytest.raises(RuntimeError):
                await handle.ready()
            clock[0] += 2.1
            await handle.ready()
            assert len(calls) == 3

        run(go())

    def test_migrate_false_opens_no_connection_and_runs_no_ddl(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def go() -> None:
            handle, calls, _ = _handle_with_migration(monkeypatch, [])
            handle.migrate = False
            await handle.ready()
            assert calls == []

        run(go())


class _Cursor:
    def __init__(self, row: tuple[Any, ...] | None) -> None:
        self._row = row
        self.description = [object()] if row is not None else None
        self.rowcount = 0

    async def fetchone(self) -> tuple[Any, ...] | None:
        return self._row

    async def fetchall(self) -> list[tuple[Any, ...]]:
        return [self._row] if self._row is not None else []


class _FakeConnection:
    """Answers the migration's catalog queries from a script and logs every statement and transaction boundary."""

    def __init__(
        self,
        *,
        has_column: bool = True,
        index_state: str = "valid",
        lock_grants: list[bool] | None = None,
        fail_reset: bool = False,
        race_failures: int = 0,
    ) -> None:
        self.log: list[str] = []
        self.autocommit = True
        self.closed_by_test = False
        self._has_column = has_column
        self._index_state = index_state
        self._lock_grants = list(lock_grants) if lock_grants is not None else [True]
        self._fail_reset = fail_reset
        self._race_failures = race_failures

    async def set_autocommit(self, value: bool) -> None:
        self.autocommit = value

    async def close(self) -> None:
        self.closed_by_test = True
        self.log.append("CLOSE")

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        self.log.append("BEGIN")
        try:
            yield
        except BaseException:
            self.log.append("ROLLBACK")
            raise
        self.log.append("COMMIT")

    async def execute(self, sql: str, params: Any = None) -> _Cursor:
        head = " ".join(sql.split())[:70]
        self.log.append(head)
        if sql.startswith("RESET") and self._fail_reset:
            raise RuntimeError("reset failed")
        if "pg_try_advisory_lock" in sql:
            granted = (
                self._lock_grants.pop(0) if len(self._lock_grants) > 1 else self._lock_grants[0]
            )
            return _Cursor((granted,))
        if "to_regclass(%s) AS oid" in sql:
            return _Cursor((True, self._has_column))
        if "pg_index WHERE indexrelid" in sql:
            return _Cursor(
                None if self._index_state == "missing" else (self._index_state == "valid",)
            )
        if "SELECT version FROM" in sql:
            return _Cursor((1,))
        if sql.lstrip().startswith("CREATE TABLE IF NOT EXISTS") and self._race_failures > 0:
            self._race_failures -= 1
            raise pg_errors.DuplicateTable("relation already exists")
        return _Cursor(None)


class _FakePool:
    def __init__(self, conn: _FakeConnection) -> None:
        self.conn = conn
        self.closed = False

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[_FakeConnection]:
        yield self.conn


async def _migrate(conn: _FakeConnection, schema: str = "public") -> None:
    await connection_module._migrate_schema(_FakePool(conn), schema)  # type: ignore[arg-type]


class TestMigrationTransaction:
    def test_retries_once_on_a_concurrent_ddl_race_and_then_succeeds(self) -> None:
        async def go() -> None:
            conn = _FakeConnection(race_failures=1)
            await _migrate(conn)
            assert conn.log.count("BEGIN") == 2
            assert conn.log.count("ROLLBACK") == 1
            assert conn.log.count("COMMIT") == 1

        run(go())

    def test_does_not_retry_a_second_race(self) -> None:
        async def go() -> None:
            conn = _FakeConnection(race_failures=2)
            with pytest.raises(pg_errors.DuplicateTable):
                await _migrate(conn)

        run(go())

    def test_issues_no_alter_table_and_no_index_ddl_when_both_already_exist_and_are_valid(
        self,
    ) -> None:
        async def go() -> None:
            conn = _FakeConnection(has_column=True, index_state="valid")
            await _migrate(conn)
            assert not any("ALTER TABLE" in s and "ADD COLUMN" in s for s in conn.log)
            assert not any("CREATE INDEX CONCURRENTLY" in s or "DROP INDEX" in s for s in conn.log)

        run(go())

    def test_adds_the_column_inside_the_transaction_and_builds_the_index_after_commit(
        self,
    ) -> None:
        async def go() -> None:
            conn = _FakeConnection(has_column=False, index_state="missing")
            await _migrate(conn)
            add_column = next(i for i, s in enumerate(conn.log) if "ADD COLUMN IF NOT EXISTS" in s)
            commit = conn.log.index("COMMIT")
            index_build = next(
                i for i, s in enumerate(conn.log) if "CREATE INDEX CONCURRENTLY" in s
            )
            assert conn.log.index("BEGIN") < add_column < commit < index_build

        run(go())

    def test_builds_only_the_index_when_the_column_is_there_but_the_index_is_not(self) -> None:
        async def go() -> None:
            conn = _FakeConnection(has_column=True, index_state="missing")
            await _migrate(conn)
            assert not any("ADD COLUMN IF NOT EXISTS" in s for s in conn.log)
            assert any("CREATE INDEX CONCURRENTLY" in s for s in conn.log)

        run(go())

    def test_drops_an_invalid_leftover_concurrently_then_rebuilds_it(self) -> None:
        async def go() -> None:
            conn = _FakeConnection(has_column=True, index_state="invalid")
            await _migrate(conn)
            drop = next(i for i, s in enumerate(conn.log) if "DROP INDEX CONCURRENTLY" in s)
            build = next(i for i, s in enumerate(conn.log) if "CREATE INDEX CONCURRENTLY" in s)
            assert drop < build

        run(go())

    def test_holds_one_session_lock_across_the_transaction_and_the_index_build_taken_before_begin(
        self,
    ) -> None:
        async def go() -> None:
            conn = _FakeConnection(has_column=False, index_state="missing")
            await _migrate(conn)
            lock = next(i for i, s in enumerate(conn.log) if "pg_try_advisory_lock" in s)
            unlock = next(i for i, s in enumerate(conn.log) if "pg_advisory_unlock" in s)
            assert lock < conn.log.index("BEGIN")
            assert unlock > next(
                i for i, s in enumerate(conn.log) if "CREATE INDEX CONCURRENTLY" in s
            )
            assert sum("pg_try_advisory_lock" in s for s in conn.log) == 1

        run(go())

    def test_polls_the_lock_instead_of_blocking_on_it_while_another_migrator_holds_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def go() -> None:
            monkeypatch.setattr(connection_module, "MIGRATION_LOCK_POLL_MS", 1)
            conn = _FakeConnection(lock_grants=[False, False, True])
            await _migrate(conn)
            assert sum("pg_try_advisory_lock" in s for s in conn.log) == 3
            assert not any("pg_advisory_lock(" in s for s in conn.log)

        run(go())

    def test_rejects_once_the_lock_wait_has_passed_naming_the_lock_key_and_the_elapsed_time(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def go() -> None:
            monkeypatch.setattr(connection_module, "MIGRATION_LOCK_POLL_MS", 5)
            monkeypatch.setattr(connection_module, "MIGRATION_LOCK_WAIT_MS", 40)
            conn = _FakeConnection(lock_grants=[False])
            with pytest.raises(
                RuntimeError,
                match=r'"kohaku:schema:public".*timed out|timed out.*kohaku:schema:public',
            ):
                await _migrate(conn)

        run(go())

    def test_looks_the_index_up_by_catalog_name_so_a_long_schema_does_not_rerun_the_ddl(
        self,
    ) -> None:
        async def go() -> None:
            schema = "s" + "x" * 40 + "uniq" * 5
            ddl = lineage_correlation_ddl(schema)
            assert len(ddl.index_name) == 63
            conn = _FakeConnection(has_column=True, index_state="valid")
            await _migrate(conn, schema)
            assert not any("CONCURRENTLY" in s or "ADD COLUMN" in s for s in conn.log)

        run(go())

    def test_bounds_table_lock_waits_with_a_transaction_local_lock_timeout_set_right_after_begin(
        self,
    ) -> None:
        async def go() -> None:
            conn = _FakeConnection()
            await _migrate(conn)
            begin = conn.log.index("BEGIN")
            assert conn.log[begin + 1] == "SET LOCAL lock_timeout = 5000"

        run(go())

    def test_does_not_leak_session_settings_a_connection_whose_reset_fails_is_destroyed(
        self,
    ) -> None:
        async def go() -> None:
            conn = _FakeConnection(fail_reset=True)
            await _migrate(conn)
            assert conn.closed_by_test

        run(go())

    def test_a_healthy_connection_is_reset_and_returned_not_closed(self) -> None:
        async def go() -> None:
            conn = _FakeConnection()
            await _migrate(conn)
            assert "RESET statement_timeout" in conn.log
            assert not conn.closed_by_test

        run(go())


class TestMigrateFalse:
    def test_assert_lineage_schema_current_fails_fast_naming_the_missing_ddl(self) -> None:
        async def go() -> None:
            class _Pool:
                @asynccontextmanager
                async def connection(self) -> AsyncIterator[Any]:
                    yield _FakeConnection(has_column=False)

            with pytest.raises(
                RuntimeError, match=r"has no correlation_id column[\s\S]*ADD COLUMN"
            ):
                await connection_module.assert_lineage_schema_current(_Pool(), "public")  # type: ignore[arg-type]

        run(go())

    def test_assert_lineage_schema_current_passes_when_the_column_exists(self) -> None:
        async def go() -> None:
            class _Pool:
                @asynccontextmanager
                async def connection(self) -> AsyncIterator[Any]:
                    yield _FakeConnection(has_column=True)

            await connection_module.assert_lineage_schema_current(_Pool(), "public")  # type: ignore[arg-type]

        run(go())

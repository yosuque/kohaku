"""Postgres-backed tests beyond the shared StoragePort contract (port of packages/storage-postgres/test/{spec-cache,
lineage,snapshots,compare-and-set,schema-version}.test.ts). They need a real Postgres (see `_backend.py`; skipped
without one) because they inspect the catalog, race two port instances, or exercise the advisory-lock migration.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections.abc import Awaitable
from typing import Any, cast

import pytest
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    LineagePageRequest,
    Principal,
    PromotionState,
    UISpec,
)
from kohaku.storage.postgres import (
    POSTGRES_SCHEMA_VERSION,
    PostgresStoragePort,
    correlation_column_value,
    create_postgres_storage_port,
    lineage_correlation_ddl,
    qualified_table,
)


def _schema() -> str:
    return f"t{secrets.token_hex(6)}"


def _run[T](awaitable: Awaitable[T]) -> T:
    async def wrapper() -> T:
        return await awaitable

    return asyncio.run(wrapper())


async def _raw(url: str) -> AsyncConnection[tuple[Any, ...]]:
    return await AsyncConnection.connect(url, autocommit=True)


async def _scalar(conn: AsyncConnection[Any], sql: str, *params: Any) -> Any:
    cursor = await conn.execute(cast(Any, sql), list(params))
    row = await cursor.fetchone()
    return None if row is None else row[0]


def _spec(id_: str) -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": {"canonical": "t.v", "params": {}, "hash": "sha256:" + "0" * 64},
            "dataVersion": id_,
            "components": [{"id": "root", "type": "layout.stack", "props": {}}],
            "provenance": {"tier": "L0", "composedBy": "t", "cache": "miss"},
        }
    )


def _ev(
    event_id: str,
    type_: str = "view.composed",
    payload: dict[str, Any] | None = None,
    tenant: str | None = None,
) -> LineageEventRecord:
    return LineageEventRecord(
        id=event_id,
        ts=f"2026-01-01T00:00:{event_id.rjust(2, '0')}.000Z",
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload or {},
        tenant=tenant,
    )


def _state(
    artifact_id: str,
    tenant: str | None = None,
    status: str = "candidate",
    revision: str | None = None,
) -> PromotionState:
    return PromotionState(
        artifactId=artifact_id,
        status=status,
        updatedAt="2026-01-01T00:00:00.000Z",
        data={},
        tenant=tenant,
        revision=revision,
    )


def _fixation(
    intent_hash: str,
    tenant: str | None = None,
    fingerprint: str = "fp1",
    revision: str | None = None,
) -> FixationRecord:
    return FixationRecord(
        intentHash=intent_hash,
        canonical="sales.trend",
        structureHash="sha256:s",
        pinnedSpec=_spec(intent_hash),
        fixatedAt="2026-01-01T00:00:00.000Z",
        approver=Principal(id="admin"),
        catalogFingerprint=fingerprint,
        tenant=tenant,
        revision=revision,
    )


class TestSpecCache:
    def test_migrates_on_first_use_and_stores_the_payload_as_text(self, postgres_url: str) -> None:
        async def go() -> None:
            schema = _schema()
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            raw = await _raw(postgres_url)
            try:
                await port.ready()
                cursor = await raw.execute(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = %s ORDER BY table_name",
                    [schema],
                )
                assert [r[0] for r in await cursor.fetchall()] == [
                    "kohaku_capability_revocation",
                    "kohaku_fixation",
                    "kohaku_lineage",
                    "kohaku_promotion_state",
                    "kohaku_schema_meta",
                    "kohaku_spec_cache",
                ]
                # text, never jsonb: a jsonb column would silently reorder keys between put and get.
                assert (
                    await _scalar(
                        raw,
                        "SELECT data_type FROM information_schema.columns WHERE table_schema = %s "
                        "AND table_name = 'kohaku_spec_cache' AND column_name = 'spec'",
                        schema,
                    )
                    == "text"
                )
            finally:
                await raw.close()
                await port.close()

        _run(go())

    def test_stores_and_returns_a_spec_upserting_on_repeat_and_none_for_an_unknown_key(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            port = create_postgres_storage_port(connection_string=postgres_url, schema=_schema())
            try:
                await port.put_spec_cache("k1", _spec("k1"))
                await port.put_spec_cache("k1", _spec("k1b"))
                assert await port.get_spec_cache("k1") == _spec("k1b")
                assert await port.get_spec_cache("nope") is None
            finally:
                await port.close()

        _run(go())

    def test_treats_an_expired_entry_as_a_miss_and_sweeps_it(self, postgres_url: str) -> None:
        async def go() -> None:
            schema = _schema()
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            raw = await _raw(postgres_url)
            try:
                await port.put_spec_cache("short", _spec("short"), ttl_seconds=1)
                await raw.execute(
                    cast(
                        Any,
                        f"UPDATE {qualified_table(schema, 'kohaku_spec_cache')} "
                        "SET expires_at = now() - interval '1 second' WHERE key = 'short'",
                    )
                )
                assert await port.get_spec_cache("short") is None
                assert await port.sweep_expired_spec_cache() == 1
                assert await port.sweep_expired_spec_cache() == 0
            finally:
                await raw.close()
                await port.close()

        _run(go())

    def test_is_shared_across_two_port_instances(self, postgres_url: str) -> None:
        async def go() -> None:
            schema = _schema()
            a = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            b = create_postgres_storage_port(
                connection_string=postgres_url, schema=schema, migrate=False
            )
            try:
                await a.put_spec_cache("shared", _spec("shared"))
                assert await b.get_spec_cache("shared") == _spec("shared")
            finally:
                await a.close()
                await b.close()

        _run(go())

    def test_close_on_an_injected_pool_leaves_the_pool_usable(self, postgres_url: str) -> None:
        async def go() -> None:
            pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]] = AsyncConnectionPool(
                postgres_url, kwargs={"autocommit": True}, min_size=1, open=False
            )
            await pool.open(wait=True)
            try:
                injected = create_postgres_storage_port(pool=pool, schema=_schema())
                await injected.put_spec_cache("k", _spec("k"))
                await injected.close()
                async with pool.connection() as conn:
                    assert await _scalar(conn, "SELECT 1") == 1
            finally:
                await pool.close()

        _run(go())

    def test_keeps_the_exact_text_that_was_written(self, postgres_url: str) -> None:
        async def go() -> None:
            schema = _schema()
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            raw = await _raw(postgres_url)
            try:
                await port.put_spec_cache("order-check", _spec("o"))
                stored = await _scalar(
                    raw,
                    f"SELECT spec FROM {qualified_table(schema, 'kohaku_spec_cache')} "
                    "WHERE key = 'order-check'",
                )
                # Compact separators and the model's own key order, byte for byte (jsonb would reorder them).
                assert stored == json.dumps(_spec("o").to_wire(), separators=(",", ":"))
            finally:
                await raw.close()
                await port.close()

        _run(go())


class TestLineage:
    def test_filters_reads_and_oversized_correlation_ids(self, postgres_url: str) -> None:
        async def go() -> None:
            schema = _schema()
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            raw = await _raw(postgres_url)
            try:
                await port.append_lineage(
                    _ev(
                        "01",
                        payload={"intentHash": "h1", "artifactId": "a1", "correlationId": "c1"},
                        tenant="acme",
                    )
                )
                await port.append_lineage(
                    _ev("02", type_="component.generated", payload={"artifactId": "a1"})
                )
                await port.append_lineage(
                    _ev("03", payload={"intentHash": "h2", "specHash": "s3"}, tenant="globex")
                )
                await port.append_lineage(
                    _ev("04", payload={"intentHash": "h1", "correlationId": "c1"}, tenant="acme")
                )

                def ids(events: list[LineageEventRecord]) -> list[str]:
                    return [e.id for e in events]

                assert ids(await port.list_lineage()) == ["01", "02", "03", "04"]
                assert ids(await port.list_lineage(LineageFilter(intentHash="h1"))) == ["01", "04"]
                assert ids(await port.list_lineage(LineageFilter(artifactId="a1"))) == ["01", "02"]
                assert ids(await port.list_lineage(LineageFilter(specHash="s3"))) == ["03"]
                assert ids(await port.list_lineage(LineageFilter(tenant="acme"))) == ["01", "04"]
                assert ids(
                    await port.list_lineage(
                        LineageFilter(type=["component.generated", "view.composed"])
                    )
                ) == ["01", "02", "03", "04"]
                assert ids(await port.list_lineage(LineageFilter(correlationId="c1"))) == [
                    "01",
                    "04",
                ]
                assert (
                    await port.list_lineage(LineageFilter(intentHash="h1", tenant="globex")) == []
                )
                assert ids(
                    await port.list_lineage(
                        LineageFilter(
                            tenant="acme", type=["view.composed"], since="2026-01-01T00:00:02.000Z"
                        )
                    )
                ) == ["04"]
                assert ids(
                    await port.list_lineage(
                        LineageFilter(until="2026-01-01T00:00:02.000Z", limit=1)
                    )
                ) == ["02"]
                assert await port.list_lineage(LineageFilter(limit=0)) == []
                assert ids(await port.list_lineage(LineageFilter(limit=2))) == ["03", "04"]
                (first,) = await port.list_lineage(LineageFilter(intentHash="h1", limit=1))
                assert first == _ev(
                    "04", payload={"intentHash": "h1", "correlationId": "c1"}, tenant="acme"
                )
                assert await port.list_lineage(LineageFilter(type=[])) == []

                # The payload keeps its exact key order (a jsonb column would reorder it), as the TS suite pins.
                non_canonical = _ev(
                    "99", payload={"zzz": 1, "a": {"deep2": True, "d": 1}, "bb": "x"}
                )
                await port.append_lineage(non_canonical)
                (read_back,) = await port.list_lineage(LineageFilter(limit=1))
                assert json.dumps(read_back.payload) == json.dumps(non_canonical.payload)

                # An oversized correlation id: the digest is stored in the column, the record keeps the original,
                # and the filter by the full id still finds it.
                long = "req-" + "x" * 4096
                await port.append_lineage(_ev("77", payload={"correlationId": long}))
                stored = await _scalar(
                    raw,
                    f"SELECT correlation_id FROM {qualified_table(schema, 'kohaku_lineage')} "
                    "WHERE id = '77'",
                )
                assert stored == correlation_column_value(long)
                (found,) = await port.list_lineage(LineageFilter(correlationId=long))
                assert found.payload["correlationId"] == long
            finally:
                await raw.close()
                await port.close()

        _run(go())


class TestPromotionStateAndFixation:
    def test_behaviour_beyond_the_shared_contract(self, postgres_url: str) -> None:
        async def go() -> None:
            schema = _schema()
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            raw = await _raw(postgres_url)
            try:
                await port.put_promotion_state(_state("a1"))
                await port.put_promotion_state(_state("a1", "acme", "published"))
                first = await port.get_promotion_state("a1")
                assert first is not None and first.status == "candidate"
                second = await port.get_promotion_state("a1", "acme")
                assert second is not None and second.status == "published"
                assert await port.get_promotion_state("a1", "globex") is None
                assert [(s.artifactId, s.tenant) for s in await port.list_promotion_states()] == [
                    ("a1", None),
                    ("a1", "acme"),
                ]
                assert [s.status for s in await port.list_promotion_states("acme")] == ["published"]

                # First-insertion order survives an overwrite.
                await port.put_promotion_state(_state("a2", "acme"))
                await port.put_promotion_state(_state("a1", "acme", "withdrawn"))
                assert [s.artifactId for s in await port.list_promotion_states("acme")] == [
                    "a1",
                    "a2",
                ]

                await port.put_promotion_states([_state("b1", "globex"), _state("b2", "globex")])
                assert [s.artifactId for s in await port.list_promotion_states("globex")] == [
                    "b1",
                    "b2",
                ]
                await port.put_promotion_states([])
                # A duplicate key inside one batch is collapsed (last write wins), not rejected by Postgres.
                await port.put_promotion_states(
                    [_state("d1", "dup", "candidate"), _state("d1", "dup", "approved")]
                )
                dup = await port.get_promotion_state("d1", "dup")
                assert dup is not None and dup.status == "approved"

                await port.put_fixation(_fixation("h1"))
                await port.put_fixation(_fixation("h1", "acme"))
                tenantless = await port.get_fixation("h1")
                assert tenantless is not None and tenantless.tenant is None
                assert await port.get_fixation("h1", "globex") is None
                assert len(await port.list_fixations()) == 2
                assert len(await port.list_fixations("acme")) == 1

                await port.put_fixation(_fixation("h9", "acme"), if_present=True)
                assert await port.get_fixation("h9", "acme") is None
                await port.put_fixation(_fixation("h1", "acme", "fp2"), if_present=True)
                updated = await port.get_fixation("h1", "acme")
                assert updated is not None and updated.catalogFingerprint == "fp2"

                await port.delete_fixation("h1", "acme")
                assert await port.get_fixation("h1", "acme") is None
                assert len(await port.list_fixations("acme")) == 0
                assert len(await port.list_fixations()) == 1
                await port.delete_fixation("h1", "acme")  # idempotent

                # Stored as TS-shaped compact text: the tenant-neutral row has the '' tenant and no tenant key.
                text = await _scalar(
                    raw,
                    f"SELECT state FROM {qualified_table(schema, 'kohaku_promotion_state')} "
                    "WHERE tenant = '' AND artifact_id = 'a1'",
                )
                assert (
                    text
                    == '{"artifactId":"a1","status":"candidate","updatedAt":"2026-01-01T00:00:00.000Z","data":{}}'
                )
            finally:
                await raw.close()
                await port.close()

        _run(go())

    def test_declares_the_optional_extensions(self) -> None:
        port = create_postgres_storage_port(connection_string="postgresql://example/db")
        assert callable(port.put_promotion_states)
        assert callable(port.delete_fixation)
        assert callable(port.page_lineage)
        assert port.supports_compare_and_set is True


class TestCompareAndSetAcrossInstances:
    """Two ports on the same database and schema stand in for two host instances (separate pools, no shared
    in-process state): the conditional UPDATE / INSERT ... DO NOTHING / DELETE is the only thing that can make exactly
    one of two writes from the same base win."""

    @staticmethod
    async def _pair(url: str) -> tuple[PostgresStoragePort, PostgresStoragePort]:
        schema = _schema()
        a = create_postgres_storage_port(connection_string=url, schema=schema)
        await a.ready()
        b = create_postgres_storage_port(connection_string=url, schema=schema)
        await b.ready()
        return a, b

    def test_lets_exactly_one_of_two_instances_win_a_promotion_write_every_round(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            a, b = await self._pair(postgres_url)
            try:
                for round_ in range(25):
                    tenant = f"t{round_}"
                    await a.put_promotion_state(_state("a1", tenant, revision="base"))
                    settled = await asyncio.gather(
                        a.put_promotion_state(
                            _state("a1", tenant, "approved", f"a{round_}"), expected_revision="base"
                        ),
                        b.put_promotion_state(
                            _state("a1", tenant, "rejected", f"b{round_}"), expected_revision="base"
                        ),
                        return_exceptions=True,
                    )
                    losers = [r for r in settled if isinstance(r, BaseException)]
                    assert len(losers) == 1
                    assert getattr(losers[0], "code", None) == "STORAGE_CONFLICT"
            finally:
                await a.close()
                await b.close()

        _run(go())

    def test_lets_exactly_one_of_two_instances_create_a_record_when_both_expect_it_absent(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            a, b = await self._pair(postgres_url)
            try:
                for round_ in range(25):
                    tenant = f"n{round_}"
                    settled = await asyncio.gather(
                        a.put_promotion_state(
                            _state("a1", tenant, revision=f"a{round_}"), expected_revision=None
                        ),
                        b.put_promotion_state(
                            _state("a1", tenant, revision=f"b{round_}"), expected_revision=None
                        ),
                        return_exceptions=True,
                    )
                    assert len([r for r in settled if not isinstance(r, BaseException)]) == 1
            finally:
                await a.close()
                await b.close()

        _run(go())

    def test_lets_a_delete_and_a_write_from_the_same_base_race_with_exactly_one_winner(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            a, b = await self._pair(postgres_url)
            try:
                for round_ in range(25):
                    tenant = f"d{round_}"
                    await a.put_fixation(_fixation("h1", tenant, revision="r1"))
                    settled = await asyncio.gather(
                        a.delete_fixation("h1", tenant, expected_revision="r1"),
                        b.put_fixation(
                            _fixation("h1", tenant, revision="r2"), expected_revision="r1"
                        ),
                        return_exceptions=True,
                    )
                    assert len([r for r in settled if not isinstance(r, BaseException)]) == 1
            finally:
                await a.close()
                await b.close()

        _run(go())

    def test_keeps_the_revision_predicate_working_on_a_payload_with_no_revision_key(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            a, b = await self._pair(postgres_url)
            try:
                await a.put_promotion_state(_state("legacy"))
                with pytest.raises(Exception) as caught:
                    await b.put_promotion_state(
                        _state("legacy", revision="r2"), expected_revision="r1"
                    )
                assert getattr(caught.value, "code", None) == "STORAGE_CONFLICT"
            finally:
                await a.close()
                await b.close()

        _run(go())


class TestSchemaVersioning:
    def test_fails_ready_with_both_versions_when_a_deployed_schema_is_on_another_version(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = _schema()
            first = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            await first.ready()
            await first.close()
            raw = await _raw(postgres_url)
            try:
                await raw.execute(
                    cast(
                        Any,
                        f"UPDATE {qualified_table(schema, 'kohaku_schema_meta')} SET version = 999",
                    )
                )
            finally:
                await raw.close()
            second = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            try:
                with pytest.raises(
                    RuntimeError,
                    match=f"{POSTGRES_SCHEMA_VERSION}.*999|999.*{POSTGRES_SCHEMA_VERSION}",
                ):
                    await second.ready()
            finally:
                await second.close()

        _run(go())

    def test_fails_ready_when_a_preexisting_lineage_table_lacks_a_unique_id(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = _schema()
            raw = await _raw(postgres_url)
            try:
                await raw.execute(cast(Any, f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))
                await raw.execute(
                    cast(
                        Any,
                        f"""CREATE TABLE "{schema}"."kohaku_lineage" (
                          seq bigserial PRIMARY KEY, id text NOT NULL, ts text NOT NULL,
                          tenant text NOT NULL DEFAULT '', type text NOT NULL, intent_hash text NULL,
                          artifact_id text NULL, spec_hash text NULL, record text NOT NULL)""",
                    )
                )
            finally:
                await raw.close()
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            try:
                with pytest.raises(RuntimeError, match=r'unique constraint/index on "id"'):
                    await port.ready()
            finally:
                await port.close()

        _run(go())

    def test_upgrades_a_pre_0_4_lineage_in_place_and_a_second_ready_is_a_no_op(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = _schema()
            raw = await _raw(postgres_url)
            try:
                await raw.execute(cast(Any, f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))
                await raw.execute(
                    cast(
                        Any,
                        f"""CREATE TABLE "{schema}"."kohaku_lineage" (
                          seq bigserial PRIMARY KEY, id text NOT NULL, ts text COLLATE "C" NOT NULL,
                          tenant text NOT NULL DEFAULT '', type text NOT NULL, intent_hash text NULL,
                          artifact_id text NULL, spec_hash text NULL, record text NOT NULL, UNIQUE (id))""",
                    )
                )

                async def catalog() -> tuple[int, int]:
                    column = await _scalar(
                        raw,
                        "SELECT count(*) FROM information_schema.columns WHERE table_schema = %s "
                        "AND table_name = 'kohaku_lineage' AND column_name = 'correlation_id'",
                        schema,
                    )
                    index = await _scalar(
                        raw,
                        "SELECT count(*) FROM pg_indexes WHERE schemaname = %s "
                        "AND indexname LIKE '%%correlation_id_idx'",
                        schema,
                    )
                    return int(column), int(index)

                assert await catalog() == (0, 0)
                first = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
                await first.ready()
                await first.close()
                assert await catalog() == (1, 1)
                second = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
                await second.ready()
                await second.close()
                assert await catalog() == (1, 1)
            finally:
                await raw.close()

        _run(go())

    def test_leaves_no_session_setting_on_the_pooled_connection(self, postgres_url: str) -> None:
        async def go() -> None:
            pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]] = AsyncConnectionPool(
                postgres_url,
                kwargs={"autocommit": True, "options": "-c statement_timeout=7000"},
                min_size=1,
                max_size=1,
                open=False,
            )
            await pool.open(wait=True)
            try:
                await create_postgres_storage_port(pool=pool, schema=_schema()).ready()
                # max_size 1: the very connection that ran the index build is the one queried here.
                async with pool.connection() as conn:
                    assert await _scalar(conn, "SHOW statement_timeout") == "7s"
                    assert conn.autocommit is True
            finally:
                await pool.close()

        _run(go())

    def test_a_non_autocommit_injected_pool_migrates_and_gets_its_setting_back(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]] = AsyncConnectionPool(
                postgres_url, min_size=1, max_size=1, open=False
            )
            await pool.open(wait=True)
            try:
                port = create_postgres_storage_port(pool=pool, schema=_schema())
                await port.ready()
                await port.put_spec_cache("k", _spec("k"))
                assert await port.get_spec_cache("k") == _spec("k")
                async with pool.connection() as conn:
                    assert conn.autocommit is False
            finally:
                await pool.close()

        _run(go())

    def test_does_not_rerun_correlation_ddl_when_the_schema_name_truncates_the_index_name(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = (f"s{'x' * 40}{_schema()}")[:60]
            ddl = lineage_correlation_ddl(schema)
            assert len(f"{schema.lower()}_kohaku_lineage_correlation_id_idx") > 63
            first = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            await first.ready()
            await first.close()
            raw = await _raw(postgres_url)
            try:
                found = await _scalar(
                    raw,
                    "SELECT count(*) FROM pg_indexes WHERE schemaname = %s AND indexname = %s",
                    schema,
                    ddl.index_name,
                )
                assert found == 1
                second = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
                await second.ready()  # no CREATE INDEX CONCURRENTLY of a name that already exists
                await second.close()
            finally:
                await raw.close()

        _run(go())

    def test_drops_and_rebuilds_an_invalid_correlation_index_left_by_a_failed_concurrent_build(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = _schema()
            ddl = lineage_correlation_ddl(schema)
            first = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            await first.ready()
            for event_id in ("a", "b"):
                await first.append_lineage(_ev(event_id, payload={"correlationId": "dup"}))
            await first.close()
            raw = await _raw(postgres_url)
            try:
                table = f'"{schema}"."kohaku_lineage"'
                await raw.execute(cast(Any, f'DROP INDEX "{schema}"."{ddl.index_name}"'))
                # A unique build over duplicate values fails and leaves the index INVALID under the same name.
                with pytest.raises(Exception):  # noqa: B017 - a unique-violation, whichever driver class
                    await raw.execute(
                        cast(
                            Any,
                            f"CREATE UNIQUE INDEX CONCURRENTLY {ddl.index_name} ON {table} (correlation_id)",
                        )
                    )

                async def state() -> tuple[Any, ...] | None:
                    cursor = await raw.execute(
                        "SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid = to_regclass(%s)",
                        [f'"{schema}"."{ddl.index_name}"'],
                    )
                    return await cursor.fetchone()

                assert await state() == (False, True)
                second = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
                await second.ready()
                await second.close()
                assert await state() == (True, False)
            finally:
                await raw.close()

        _run(go())

    def test_migrate_false_fails_naming_the_missing_correlation_ddl_and_passes_once_added(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = _schema()
            setup = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            await setup.ready()
            await setup.close()
            raw = await _raw(postgres_url)
            port = create_postgres_storage_port(
                connection_string=postgres_url, schema=schema, migrate=False
            )
            try:
                await raw.execute(
                    cast(
                        Any,
                        f'ALTER TABLE "{schema}"."kohaku_lineage" DROP COLUMN correlation_id',
                    )
                )
                with pytest.raises(
                    RuntimeError, match=r"has no correlation_id column[\s\S]*ADD COLUMN"
                ):
                    await port.ready()
                with pytest.raises(RuntimeError, match=r"Upgrading to 0\.4\.x"):
                    await port.append_lineage(_ev("x"))
                await raw.execute(
                    cast(
                        Any,
                        f'ALTER TABLE "{schema}"."kohaku_lineage" ADD COLUMN correlation_id text NULL',
                    )
                )
                await port.ready()
            finally:
                await raw.close()
                await port.close()

        _run(go())

    def test_several_ports_calling_ready_concurrently_on_a_fresh_schema_all_succeed_repeatedly(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            # Repeated on fresh schemas so a lock-ordering regression (a migrator's transaction waiting behind
            # another's CREATE INDEX CONCURRENTLY, which waits for that transaction: 40P01) shows up reliably.
            for round_ in range(10):
                schema = _schema()
                ports = [
                    create_postgres_storage_port(connection_string=postgres_url, schema=schema)
                    for _ in range(3)
                ]
                try:
                    await asyncio.gather(*(p.ready() for p in ports))
                    spec = _spec(f"concurrent-ready-{round_}")
                    await ports[0].put_spec_cache("k", spec)
                    assert await ports[2].get_spec_cache("k") == spec
                finally:
                    await asyncio.gather(*(p.close() for p in ports))

        _run(go())


class TestSchemaNameWithPercent:
    """A `%` in the schema name (KOHAKU_POSTGRES_SCHEMA is operator input) is a psycopg placeholder in every
    parametrized statement unless the embedded identifier is escaped."""

    def test_every_statement_family_works_in_a_schema_containing_a_percent_sign(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = f"p%s_{secrets.token_hex(4)}%d"
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            from kohaku.storage.postgres import create_postgres_revocation_store

            store = create_postgres_revocation_store(connection_string=postgres_url, schema=schema)
            try:
                await port.put_spec_cache("k", _spec("k"), ttl_seconds=60)
                assert await port.get_spec_cache("k") == _spec("k")
                assert await port.sweep_expired_spec_cache() == 0
                await port.append_lineage(_ev("01", payload={"correlationId": "c"}))
                assert [
                    e.id for e in await port.list_lineage(LineageFilter(correlationId="c"))
                ] == ["01"]
                assert (await port.page_lineage(LineagePageRequest())).events[0].id == "01"
                await port.put_promotion_state(_state("a1", revision="r1"), expected_revision=None)
                await port.put_promotion_states([_state("b1"), _state("b2")])
                assert len(await port.list_promotion_states()) == 3
                await port.put_fixation(_fixation("h", revision="r1"), expected_revision=None)
                await port.put_fixation(
                    _fixation("h", revision="r2"), if_present=True, expected_revision="r1"
                )
                await port.delete_fixation("h", None, expected_revision="r2")
                assert await port.get_fixation("h") is None
                await store.revoke("j", int(time.time()) + 60)
                assert await store.is_revoked("j") is True
                assert await store.sweep_expired_revocations() == 0
            finally:
                await store.close()
                await port.close()

        _run(go())


class TestCorruptRows:
    def test_a_row_that_does_not_parse_raises_in_get_and_list_like_the_ts_adapter(
        self, postgres_url: str
    ) -> None:
        async def go() -> None:
            schema = _schema()
            port = create_postgres_storage_port(connection_string=postgres_url, schema=schema)
            raw = await _raw(postgres_url)
            try:
                await port.ready()
                await raw.execute(
                    cast(
                        Any,
                        f"INSERT INTO {qualified_table(schema, 'kohaku_promotion_state')} (tenant, artifact_id, state) "
                        "VALUES ('', 'bad', '{not json')",
                    )
                )
                with pytest.raises(ValueError):
                    await port.get_promotion_state("bad")
                with pytest.raises(ValueError):
                    await port.list_promotion_states()
                await raw.execute(
                    cast(
                        Any,
                        f"INSERT INTO {qualified_table(schema, 'kohaku_lineage')} (id, ts, type, record) "
                        "VALUES ('x', '2026', 'view.composed', 'oops')",
                    )
                )
                with pytest.raises(ValueError):
                    await port.list_lineage()
            finally:
                await raw.close()
                await port.close()

        _run(go())

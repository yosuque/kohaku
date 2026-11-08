"""The record-kind-agnostic read / write statements of a ``(tenant, <id column>)``-keyed table whose rows hold one
JSON payload stored as text (see schema.py for why it is never jsonb) and a ``seq`` first-insertion order (port of
packages/storage-postgres/src/tenant-keyed-table.ts). The promotion-state and fixation tables share this shape, so
both ports' methods are thin calls into one of these. It does not call ``ready()`` -- the caller does, first, exactly
where it always did (so a batch write can still return on an empty input before touching the pool).
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any, Literal

from psycopg import errors as pg_errors

from kohaku.spec import UNSET, ExpectedRevision, StorageConflictError, normalize_tenant

from .connection import PostgresPoolHandle, QueryResult


class TenantKeyedTable[T]:
    def __init__(
        self,
        db: PostgresPoolHandle,
        table: str,
        id_column: str,
        payload_column: str,
        kind: Literal["promotion", "fixation"],
        to_json: Callable[[T], str],
        from_wire: Callable[[dict[str, Any]], T],
    ) -> None:
        self._db = db
        self._table = table
        self._id_column = id_column
        self._payload_column = payload_column
        self._kind = kind
        self._to_json = to_json
        self._from_wire = from_wire
        # The payload is stored as text (see schema.py), so the revision predicate casts it to jsonb. No DDL: the
        # compare-and-set is one conditional statement whose rowcount says whether it applied.
        self._revision_of = f"({payload_column}::jsonb ->> 'revision')"

    async def _cas_query(self, record_id: str, sql: str, params: list[Any]) -> QueryResult:
        """Runs a conditional (compare-and-set) statement. SQLSTATE 40001 (serialization failure -- what a
        SERIALIZABLE / REPEATABLE READ session, or a pool configured that way, raises when a concurrent writer
        touched the row) means the same as a zero row count: another writer got there first, so it is a conflict."""
        try:
            return await self._db.query(sql, params)
        except pg_errors.SerializationFailure as error:
            raise StorageConflictError(self._kind, record_id) from error

    def _decode(self, raw: str) -> T | None:
        """Parses a stored payload, treating one that does not parse (a corrupted or hand-edited row) as absent with
        a stderr note -- the file port's per-entry tolerance, so one bad row cannot take a whole listing down."""
        try:
            return self._from_wire(json.loads(raw))
        except Exception as error:
            print(
                f"[storage-postgres] skipped a malformed {self._kind} row: {error}", file=sys.stderr
            )
            return None

    async def get(self, tenant: str | None, record_id: str) -> T | None:
        """The record for ``(tenant, id)``, or None. An unspecified or ``''`` tenant is the tenant-neutral key."""
        result = await self._db.query(
            f"SELECT {self._payload_column} FROM {self._table} WHERE tenant = %s AND {self._id_column} = %s",
            [normalize_tenant(tenant) or "", record_id],
        )
        return self._decode(result.rows[0][0]) if result.rows else None

    async def put(
        self,
        tenant: str | None,
        record_id: str,
        record: T,
        expected_revision: ExpectedRevision = UNSET,
    ) -> None:
        """Upserts one record, keeping its first-insertion ``seq``. ``expected_revision`` makes it a
        compare-and-set (UNSET = the plain upsert): None = insert only if the row is absent, a str = update only if the
        stored payload's ``revision`` equals it; a miss raises `StorageConflictError`."""
        normalized = normalize_tenant(tenant) or ""
        payload = self._to_json(record)
        if expected_revision is None:
            # Must not exist yet: a lost insert race (or an existing row) inserts nothing.
            inserted = await self._cas_query(
                record_id,
                f"INSERT INTO {self._table} (tenant, {self._id_column}, {self._payload_column}) VALUES (%s, %s, %s) "
                f"ON CONFLICT (tenant, {self._id_column}) DO NOTHING",
                [normalized, record_id, payload],
            )
            if inserted.rowcount == 0:
                raise StorageConflictError(self._kind, record_id)
            return
        if expected_revision is not UNSET:
            updated = await self._cas_query(
                record_id,
                f"UPDATE {self._table} SET {self._payload_column} = %s "
                f"WHERE tenant = %s AND {self._id_column} = %s AND {self._revision_of} = %s::text",
                [payload, normalized, record_id, expected_revision],
            )
            if updated.rowcount == 0:
                raise StorageConflictError(self._kind, record_id)
            return
        await self._db.query(
            f"INSERT INTO {self._table} (tenant, {self._id_column}, {self._payload_column}) VALUES (%s, %s, %s) "
            f"ON CONFLICT (tenant, {self._id_column}) DO UPDATE SET {self._payload_column} = "
            f"EXCLUDED.{self._payload_column}",
            [normalized, record_id, payload],
        )

    async def update_existing(
        self, tenant: str | None, record_id: str, record: T, expected_revision: str | None = None
    ) -> None:
        """Replaces the payload of an existing ``(tenant, id)`` row only; never creates one. With
        ``expected_revision`` the row must also carry exactly that ``revision``: an absent row is still a silent
        no-op, a present row with a different revision raises `StorageConflictError`."""
        normalized = normalize_tenant(tenant) or ""
        payload = self._to_json(record)
        if expected_revision is None:
            await self._db.query(
                f"UPDATE {self._table} SET {self._payload_column} = %s "
                f"WHERE tenant = %s AND {self._id_column} = %s",
                [payload, normalized, record_id],
            )
            return
        updated = await self._cas_query(
            record_id,
            f"UPDATE {self._table} SET {self._payload_column} = %s "
            f"WHERE tenant = %s AND {self._id_column} = %s AND {self._revision_of} = %s::text",
            [payload, normalized, record_id, expected_revision],
        )
        if updated.rowcount != 0:
            return
        # Zero rows: either the row is absent (if_present's silent no-op) or it carries another revision (a
        # conflict). The existence probe is not atomic with the UPDATE, but both answers are valid for a row deleted
        # or replaced in between.
        probe = await self._db.query(
            f"SELECT 1 FROM {self._table} WHERE tenant = %s AND {self._id_column} = %s",
            [normalized, record_id],
        )
        if probe.rowcount != 0:
            raise StorageConflictError(self._kind, record_id)

    async def put_many(self, entries: list[tuple[str | None, str, T]]) -> None:
        """Upserts every record in one ``unnest``-batched statement. Duplicates by ``(tenant, id)`` are collapsed
        first (last write wins, at the first occurrence's position): ``unnest`` feeds every row to one INSERT, so a
        duplicate key within the same call would otherwise hit ``ON CONFLICT`` twice for the same target row in one
        statement, which Postgres rejects ("ON CONFLICT DO UPDATE command cannot affect row a second time")."""
        deduped: dict[tuple[str, str], T] = {}
        for tenant, record_id, record in entries:
            deduped[(normalize_tenant(tenant) or "", record_id)] = record
        tenants = [key[0] for key in deduped]
        ids = [key[1] for key in deduped]
        payloads = [self._to_json(record) for record in deduped.values()]
        await self._db.query(
            f"INSERT INTO {self._table} (tenant, {self._id_column}, {self._payload_column}) "
            f"SELECT * FROM unnest(%s::text[], %s::text[], %s::text[]) "
            f"ON CONFLICT (tenant, {self._id_column}) DO UPDATE SET {self._payload_column} = "
            f"EXCLUDED.{self._payload_column}",
            [tenants, ids, payloads],
        )

    async def list_records(self, tenant: str | None) -> list[T]:
        """Every record in first-insertion order; an unspecified tenant lists all tenants."""
        normalized = normalize_tenant(tenant)
        if normalized is None:
            result = await self._db.query(
                f"SELECT {self._payload_column} FROM {self._table} ORDER BY seq"
            )
        else:
            result = await self._db.query(
                f"SELECT {self._payload_column} FROM {self._table} WHERE tenant = %s ORDER BY seq",
                [normalized],
            )
        decoded = (self._decode(row[0]) for row in result.rows)
        return [record for record in decoded if record is not None]

    async def delete(
        self, tenant: str | None, record_id: str, expected_revision: str | None = None
    ) -> None:
        """Deletes the ``(tenant, id)`` row (a no-op when absent). With ``expected_revision`` the delete is
        conditional on the stored payload's ``revision``; zero rows deleted (absent or different revision) raises
        `StorageConflictError`."""
        normalized = normalize_tenant(tenant) or ""
        if expected_revision is not None:
            deleted = await self._cas_query(
                record_id,
                f"DELETE FROM {self._table} WHERE tenant = %s AND {self._id_column} = %s "
                f"AND {self._revision_of} = %s::text",
                [normalized, record_id, expected_revision],
            )
            if deleted.rowcount == 0:
                raise StorageConflictError(self._kind, record_id)
            return
        await self._db.query(
            f"DELETE FROM {self._table} WHERE tenant = %s AND {self._id_column} = %s",
            [normalized, record_id],
        )

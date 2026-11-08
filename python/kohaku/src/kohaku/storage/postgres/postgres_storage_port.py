"""A PostgreSQL-backed StoragePort (port of packages/storage-postgres/src/postgres-storage-port.ts; reference adapter).

One table per record kind; (tenant, id) primary keys with '' as the tenant-neutral tenant; ``seq`` bigserial columns
give the append / first-insertion order the reference file port exposes. Single statements (or one unnest-batched
statement for the batch write) -- the cross-process concurrency contract of ports.py is unchanged except for the
optional compare-and-set, which is one conditional statement whose row count decides (no DDL): ``UPDATE ... WHERE
(payload::jsonb ->> 'revision') = $n`` / ``INSERT ... ON CONFLICT DO NOTHING`` / ``DELETE``. Connection lifecycle
(timeouts, the versioned migration) is shared with the revocation store through connection.py.

**Data-compatible with the TS adapter**: the same tables, indexes, ``POSTGRES_SCHEMA_VERSION``, advisory-lock
migration and stored JSON text (compact, TS-shaped records -- see `kohaku.storage._wire`), so a TS host and a Python
host can serve one database.
"""

from __future__ import annotations

import json
import math
from typing import Any

from kohaku.spec import (
    DEFAULT_LINEAGE_LIMIT,
    UNSET,
    ExpectedDeleteRevision,
    ExpectedRevision,
    FixationRecord,
    LineageEventRecord,
    LineageFilter,
    LineagePage,
    LineagePageRequest,
    PromotionState,
    StorageConflictError,
    UISpec,
    clamp_lineage_page_size,
    decode_seq_cursor,
    encode_seq_cursor,
    normalize_tenant,
)

from .._wire import (
    dumps_compact,
    fixation_from_wire,
    fixation_to_wire,
    lineage_from_wire,
    lineage_to_wire,
    promotion_from_wire,
    promotion_to_wire,
    spec_from_json,
    spec_to_json,
)
from .connection import (
    PostgresPoolHandle,
    assert_lineage_schema_current,
    create_postgres_pool,
)
from .schema import DEFAULT_SCHEMA, correlation_column_value, qualified_table
from .tenant_keyed_table import TenantKeyedTable

try:
    from psycopg import AsyncConnection
    from psycopg_pool import AsyncConnectionPool
except ImportError as error:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        "kohaku.storage.postgres needs psycopg 3 and its pool: install them with "
        "`pip install 'kohaku-ui[postgres]'` (plus `psycopg[binary]` unless libpq is installed)"
    ) from error


def _lineage_where(
    filter: LineageFilter | LineagePageRequest, after_seq: int | None = None
) -> tuple[list[str], list[Any]]:
    """The WHERE predicates (and their parameters) shared by `list_lineage` and `page_lineage`, in a fixed order: the
    optional ``seq > after_seq`` first, then type / tenant / intentHash / artifactId / specHash / correlationId /
    since / until. The caller appends its own trailing parameter (LIMIT)."""
    where: list[str] = []
    params: list[Any] = []

    def add(clause: str, value: Any) -> None:
        params.append(value)
        where.append(clause)

    if after_seq is not None:
        add("seq > %s", after_seq)
    if filter.type is not None:
        add("type = ANY(%s::text[])", list(filter.type))
    # '' behaves exactly like an unspecified tenant (normalize_tenant collapses both), matching every tenant column's
    # ''-for-tenant-neutral convention in this schema.
    filter_tenant = normalize_tenant(filter.tenant)
    if filter_tenant is not None:
        add("tenant = %s", filter_tenant)
    if filter.intentHash is not None:
        add("intent_hash = %s", filter.intentHash)
    if filter.artifactId is not None:
        add("artifact_id = %s", filter.artifactId)
    if filter.specHash is not None:
        add("spec_hash = %s", filter.specHash)
    if filter.correlationId is not None:
        add("correlation_id = %s", correlation_column_value(filter.correlationId))
    if filter.since is not None:
        add("ts >= %s", filter.since)
    if filter.until is not None:
        add("ts <= %s", filter.until)
    return where, params


def _payload_string(event: LineageEventRecord, key: str) -> str | None:
    value = event.payload.get(key)
    return value if isinstance(value, str) else None


class PostgresStoragePort:
    """See the module docstring. Build one with `create_postgres_storage_port`."""

    supports_compare_and_set = True
    """Declares the optional compare-and-set extension: each conditional write is one statement whose row count
    decides, so it is atomic across every host instance sharing this database."""

    def __init__(self, db: PostgresPoolHandle) -> None:
        self._db = db
        # `migrate=False` leaves the schema to the operator, so verify (read-only) that it has what `append_lineage`
        # writes instead of losing audit events to 42703. A pass is remembered; a failure is not, so an operator can
        # apply the DDL and the next call succeeds without a restart.
        self._schema_verified = db.migrate
        schema = db.schema
        self._tables = {
            "spec": qualified_table(schema, "kohaku_spec_cache"),
            "lineage": qualified_table(schema, "kohaku_lineage"),
            "promotion": qualified_table(schema, "kohaku_promotion_state"),
            "fixation": qualified_table(schema, "kohaku_fixation"),
        }
        self._promotion_states: TenantKeyedTable[PromotionState] = TenantKeyedTable(
            db,
            self._tables["promotion"],
            "artifact_id",
            "state",
            "promotion",
            lambda state: dumps_compact(promotion_to_wire(state)),
            promotion_from_wire,
        )
        self._fixations: TenantKeyedTable[FixationRecord] = TenantKeyedTable(
            db,
            self._tables["fixation"],
            "intent_hash",
            "record",
            "fixation",
            lambda record: dumps_compact(fixation_to_wire(record)),
            fixation_from_wire,
        )

    async def ready(self) -> None:
        """Resolves once the pool is open and the schema is in place (immediately after opening when
        ``migrate=False``, plus the read-only lineage-column check)."""
        await self._db.ready()
        if self._schema_verified:
            return
        await assert_lineage_schema_current(self._db.pool, self._db.schema)
        self._schema_verified = True

    async def close(self) -> None:
        """Ends the pool this port created (a no-op for an injected pool)."""
        await self._db.close()

    async def sweep_expired_spec_cache(self) -> int:
        """Deletes expired Spec-cache rows (a `get_spec_cache` already treats them as misses); returns the row
        count. For a cron."""
        await self.ready()
        result = await self._db.query(
            f"DELETE FROM {self._tables['spec']} WHERE expires_at IS NOT NULL AND expires_at <= now()"
        )
        return result.rowcount

    # -- Spec cache -------------------------------------------------------------------------------------------

    async def get_spec_cache(self, key: str) -> UISpec | None:
        await self.ready()
        # `spec` is stored as text -- see schema.py -- so this is the exact JSON that was written, with no jsonb
        # key-reordering between put and get.
        result = await self._db.query(
            f"SELECT spec FROM {self._tables['spec']} WHERE key = %s "
            f"AND (expires_at IS NULL OR expires_at > now())",
            [key],
        )
        return spec_from_json(result.rows[0][0]) if result.rows else None

    async def put_spec_cache(
        self, key: str, spec: UISpec, *, ttl_seconds: int | None = None
    ) -> None:
        await self.ready()
        ttl = math.ceil(ttl_seconds) if ttl_seconds is not None and ttl_seconds > 0 else None
        await self._db.query(
            f"INSERT INTO {self._tables['spec']} (key, spec, expires_at) "
            f"VALUES (%(key)s, %(spec)s, CASE WHEN %(ttl)s::double precision IS NULL THEN NULL "
            f"ELSE now() + (%(ttl)s::double precision * interval '1 second') END) "
            f"ON CONFLICT (key) DO UPDATE SET spec = EXCLUDED.spec, expires_at = EXCLUDED.expires_at",
            {"key": key, "spec": spec_to_json(spec), "ttl": ttl},
        )

    # -- Lineage ----------------------------------------------------------------------------------------------

    async def append_lineage(self, event: LineageEventRecord) -> None:
        """Idempotent by id (``ON CONFLICT (id) DO NOTHING``): appending an event whose `id` was already recorded
        is a no-op, not a duplicate row or a raised unique-violation. ``tenant`` is ``''`` for a tenant-neutral event
        and `record` is stored as text -- see schema.py."""
        await self.ready()
        correlation = _payload_string(event, "correlationId")
        await self._db.query(
            f"INSERT INTO {self._tables['lineage']} "
            f"(id, ts, tenant, type, intent_hash, artifact_id, spec_hash, correlation_id, record) "
            f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
            [
                event.id,
                event.ts,
                normalize_tenant(event.tenant) or "",
                event.type,
                _payload_string(event, "intentHash"),
                _payload_string(event, "artifactId"),
                _payload_string(event, "specHash"),
                None if correlation is None else correlation_column_value(correlation),
                dumps_compact(lineage_to_wire(event)),
            ],
        )

    async def list_lineage(self, filter: LineageFilter | None = None) -> list[LineageEventRecord]:
        await self.ready()
        f = filter if filter is not None else LineageFilter()
        limit = f.limit if f.limit is not None else DEFAULT_LINEAGE_LIMIT
        if limit <= 0:
            return []
        where, params = _lineage_where(f)
        params.append(limit)
        clause = f" WHERE {' AND '.join(where)}" if where else ""
        result = await self._db.query(
            f"SELECT record FROM {self._tables['lineage']}{clause} ORDER BY seq DESC LIMIT %s",
            params,
        )
        # Newest-first from the query; the contract returns append order, so reverse.
        events = [lineage_from_wire(json.loads(row[0])) for row in result.rows]
        events.reverse()
        return events

    async def page_lineage(self, req: LineagePageRequest) -> LineagePage:
        """StoragePort's optional forward-paging extension (design.md #53)."""
        await self.ready()
        page_size = clamp_lineage_page_size(req.pageSize)
        # A malformed cursor raises before any query is issued (same contract as page_lineage_events).
        after_seq = decode_seq_cursor(req.cursor) if req.cursor is not None else 0
        where, params = _lineage_where(req, after_seq)
        # Read one past page_size to detect whether a further page exists, mirroring page_lineage_events' "peek one
        # match ahead" strategy.
        params.append(page_size + 1)
        result = await self._db.query(
            f"SELECT seq, record FROM {self._tables['lineage']} WHERE {' AND '.join(where)} "
            f"ORDER BY seq ASC LIMIT %s",
            params,
        )
        has_more = len(result.rows) > page_size
        page = result.rows[:page_size] if has_more else result.rows
        events = [lineage_from_wire(json.loads(row[1])) for row in page]
        if not has_more:
            return LineagePage(events=events)
        return LineagePage(events=events, nextCursor=encode_seq_cursor(int(page[-1][0])))

    # -- Promotion state --------------------------------------------------------------------------------------

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None:
        await self.ready()
        return await self._promotion_states.get(tenant, artifact_id)

    async def put_promotion_state(
        self, state: PromotionState, *, expected_revision: ExpectedRevision = UNSET
    ) -> None:
        await self.ready()
        await self._promotion_states.put(state.tenant, state.artifactId, state, expected_revision)

    async def put_promotion_states(self, states: list[PromotionState]) -> None:
        """Batch counterpart of put_promotion_state (a genuinely optional StoragePort extension): deduplicated by
        (tenant, artifactId), last write wins, then one batched statement. No expectation: the only caller is an
        idempotent in_use -> candidate nomination pass."""
        if not states:
            return
        await self.ready()
        await self._promotion_states.put_many(
            [(state.tenant, state.artifactId, state) for state in states]
        )

    async def list_promotion_states(self, tenant: str | None = None) -> list[PromotionState]:
        await self.ready()
        return await self._promotion_states.list_records(tenant)

    # -- Fixation ---------------------------------------------------------------------------------------------

    async def get_fixation(
        self, intent_hash: str, tenant: str | None = None
    ) -> FixationRecord | None:
        await self.ready()
        return await self._fixations.get(tenant, intent_hash)

    async def put_fixation(
        self,
        record: FixationRecord,
        *,
        if_present: bool = False,
        expected_revision: ExpectedRevision = UNSET,
    ) -> None:
        await self.ready()
        if if_present:
            # "must exist" together with "must not exist" is contradictory: always a conflict.
            if expected_revision is None:
                raise StorageConflictError("fixation", record.intentHash)
            await self._fixations.update_existing(
                record.tenant,
                record.intentHash,
                record,
                None if expected_revision is UNSET else expected_revision,
            )
            return
        await self._fixations.put(record.tenant, record.intentHash, record, expected_revision)

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]:
        await self.ready()
        return await self._fixations.list_records(tenant)

    async def delete_fixation(
        self,
        intent_hash: str,
        tenant: str | None = None,
        *,
        expected_revision: ExpectedDeleteRevision = UNSET,
    ) -> None:
        await self.ready()
        await self._fixations.delete(
            tenant, intent_hash, None if expected_revision is UNSET else expected_revision
        )


def create_postgres_storage_port(
    *,
    connection_string: str | None = None,
    pool: AsyncConnectionPool[AsyncConnection[tuple[Any, ...]]] | None = None,
    schema: str = DEFAULT_SCHEMA,
    migrate: bool = True,
    connect_timeout_ms: int | None = None,
    statement_timeout_ms: int | None = None,
    max_connections: int | None = None,
) -> PostgresStoragePort:
    """Creates a PostgreSQL-backed StoragePort (TS: createPostgresStoragePort). Options as `create_postgres_pool`
    (``connection_string`` xor ``pool``; ``schema`` default "public"; ``migrate`` default True).

    A psycopg pool belongs to the event loop it first ran a query on: create and use one port inside one
    ``asyncio.run`` (a host assembling its app in one loop and serving in another needs to build the port in the
    serving loop).
    """
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
    return PostgresStoragePort(handle)

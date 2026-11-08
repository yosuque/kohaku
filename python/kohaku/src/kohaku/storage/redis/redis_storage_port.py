"""A Redis-backed StoragePort (port of packages/storage-redis/src/redis-storage-port.ts; reference adapter).

The Spec cache is a plain key with an optional EX; lineage is an append-only hash + sorted-set indexes; promotion
state and fixations are one key per (tenant, id) with sorted-set indexes for listing. All multi-key writes go
through MULTI so a crash between commands cannot leave an index pointing at a missing record. The cross-process
concurrency contract of ports.py still applies to everything except the optional compare-and-set below: the host
keys its own mutex per (tenant, key).

Every tenant parameter is normalized with `kohaku.spec.normalize_tenant` before it ever keys or filters a record
(via keys.py, which applies it at the key-building layer): ``""`` and ``None`` are always treated identically, on
both writes and reads.

**Data-compatible with the TS adapter**: the key layout (keys.py), the sorted-set indexes and their scores, and the
stored JSON text (compact, TS-shaped records -- see `kohaku.storage._wire`) are the same, so a TS host and a Python
host can serve one Redis. Lua is deliberately not used (the existing policy), so the optional compare-and-set is
WATCH / MULTI / EXEC.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any, Literal

from kohaku.spec import (
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
    normalize_tenant,
)

from .._wire import (
    dumps_compact,
    fixation_from_wire,
    fixation_to_wire,
    lineage_to_wire,
    promotion_from_wire,
    promotion_to_wire,
    spec_from_json,
    spec_to_json,
)
from .connection import (
    DEFAULT_COMMAND_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
    RedisConnection,
    create_redis_connection,
)
from .keys import DEFAULT_KEY_PREFIX, RedisKeys, redis_keys
from .lineage import index_values, read_lineage, read_lineage_page

try:
    from redis.asyncio import Redis
    from redis.exceptions import WatchError
except ImportError as error:  # pragma: no cover - exercised only without the extra installed
    raise ImportError(
        "kohaku.storage.redis needs the redis-py client: install it with `pip install 'kohaku-ui[redis]'`"
    ) from error

_WATCHED_KEY_CHANGED = "Watched variable changed."
"""The message redis-py gives the `WatchError` of a null EXEC reply (the only genuine optimistic-lock conflict)."""

type _Build = Callable[[str | None, Any, int], Literal["skip"] | None]
"""Queues one compare-and-set transaction's writes on the MULTI: sees the current raw body (None = absent) and the
reserved sequence number; raises `StorageConflictError` to abort, or returns "skip" to write nothing."""


def _queue_indexed(
    pipe: Any,
    seq: int,
    key: str,
    tenant: str | None,
    index_key: Callable[[str | None], str],
    value: str,
) -> None:
    """Queues one record's SET plus its all-tenants / per-tenant index entries on `pipe`. ZADD NX keeps the
    first-insertion position on overwrite, mirroring the file port's dict order."""
    pipe.set(key, value)
    pipe.zadd(index_key(None), {key: seq}, nx=True)
    if normalize_tenant(tenant) is not None:
        pipe.zadd(index_key(tenant), {key: seq}, nx=True)


def _revision_of(raw: str) -> str | None:
    """The record `revision` out of a stored JSON body (None when the record has none)."""
    revision = json.loads(raw).get("revision")
    return revision if isinstance(revision, str) else None


def _check_revision(
    kind: Literal["promotion", "fixation"],
    record_id: str,
    current: str | None,
    expected: ExpectedRevision,
) -> None:
    """The compare-and-set check against the raw stored body (None = absent), the same four states as
    `StoragePort`'s `expected_revision`: UNSET = no check; None = must be absent; "" = must be present and carry
    no `revision` (it predates the field); any other str = must be present with exactly that `revision`. For a
    present record that is `(revision or "") == expected`; an absent one never matches a str."""
    if expected is UNSET:
        return
    if expected is None:
        if current is not None:
            raise StorageConflictError(kind, record_id)
        return
    if current is None or (_revision_of(current) or "") != expected:
        raise StorageConflictError(kind, record_id)


class RedisStoragePort:
    """See the module docstring. Build one with `create_redis_storage_port`."""

    supports_compare_and_set = True
    """Declares the optional compare-and-set extension (`expected_revision` on put_promotion_state / put_fixation /
    delete_fixation): each conditional write is one WATCH / GET / MULTI / EXEC transaction, so it is atomic across
    every host instance sharing this Redis."""

    def __init__(self, connection: RedisConnection, key_prefix: str) -> None:
        self._connection = connection
        # Typed Any on purpose: redis-py's stubs type every reply as a `bytes | str` union regardless of
        # decode_responses (which create_redis_connection guarantees), so precise types would only add casts.
        self._redis: Any = connection.redis
        self._keys: RedisKeys = redis_keys(key_prefix)

    async def ready(self) -> None:
        """Resolves once the server answers; raises if it can't within `connect_timeout_ms`. A failed attempt is
        not remembered, so the next call (from the next method call) retries from scratch. Every method awaits it
        first, turning "Redis is unreachable" into a bounded, clearly-labelled failure."""
        await self._connection.ready()

    async def close(self) -> None:
        """Disconnects the client this port created (a no-op for an injected client, which its owner closes)."""
        await self._connection.close()

    # -- Spec cache -------------------------------------------------------------------------------------------

    async def get_spec_cache(self, key: str) -> UISpec | None:
        await self.ready()
        raw: str | None = await self._redis.get(self._keys.spec(key))
        return None if raw is None else spec_from_json(raw)

    async def put_spec_cache(
        self, key: str, spec: UISpec, *, ttl_seconds: int | None = None
    ) -> None:
        await self.ready()
        value = spec_to_json(spec)
        if ttl_seconds is not None and ttl_seconds > 0:
            await self._redis.set(self._keys.spec(key), value, ex=math.ceil(ttl_seconds))
        else:
            await self._redis.set(self._keys.spec(key), value)

    # -- Lineage ----------------------------------------------------------------------------------------------

    async def append_lineage(self, event: LineageEventRecord) -> None:
        """Idempotent, and atomic, re-append of an already-recorded id: HSETNX (the body) and ZADD NX (`by-seq`
        and every index) all go in the SAME MULTI/EXEC block, so a crash between them is impossible -- either
        every command applies, or none does. NX on every one of them means a duplicate id's write is a no-op
        across the board, so the same block serves both the fresh-append and the duplicate-append case without a
        separate check-then-act round trip.

        The `seq` value is reserved up front, unconditionally (whether this append is a duplicate is only known
        once the MULTI is queued), so a duplicate append consumes one seq value. `seq` is only ever a sort key
        (append order), never a contiguous counter, so a gap is harmless.

        Known, accepted limitation (same as the TS adapter): `index_values` is computed from THIS call's `event`,
        not from whatever body ends up stored; a duplicate id re-appended with a genuinely different payload can add
        a spurious index entry for the new payload's field values (the stored body itself is untouched).
        """
        await self.ready()
        seq: int = await self._redis.incr(self._keys.lineage.seq)
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.hsetnx(self._keys.lineage.events, event.id, dumps_compact(lineage_to_wire(event)))
            pipe.zadd(self._keys.lineage.by_seq, {event.id: seq}, nx=True)
            for entry in index_values(event):
                pipe.zadd(
                    self._keys.lineage.index(entry.field, entry.value), {event.id: seq}, nx=True
                )
            await pipe.execute()

    async def list_lineage(self, filter: LineageFilter | None = None) -> list[LineageEventRecord]:
        await self.ready()
        return await read_lineage(self._redis, self._keys, filter)

    async def page_lineage(self, req: LineagePageRequest) -> LineagePage:
        """StoragePort's optional forward-paging extension (design.md #53); see `read_lineage_page`."""
        await self.ready()
        return await read_lineage_page(self._redis, self._keys, req)

    # -- Promotion state --------------------------------------------------------------------------------------

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None:
        await self.ready()
        raw: str | None = await self._redis.get(self._keys.promotion(tenant, artifact_id))
        return None if raw is None else _decode(raw, promotion_from_wire)

    async def put_promotion_state(
        self, state: PromotionState, *, expected_revision: ExpectedRevision = UNSET
    ) -> None:
        await self.ready()
        key = self._keys.promotion(state.tenant, state.artifactId)
        value = dumps_compact(promotion_to_wire(state))
        if expected_revision is not UNSET:

            def build(current: str | None, pipe: Any, seq: int) -> Literal["skip"] | None:
                _check_revision("promotion", state.artifactId, current, expected_revision)
                _queue_indexed(pipe, seq, key, state.tenant, self._keys.promotion_index, value)
                return None

            await self._write_cas(
                "promotion", state.artifactId, key, build, self._keys.promotion_seq
            )
            return
        await self._put_indexed(
            self._keys.promotion_seq, key, state.tenant, self._keys.promotion_index, value
        )

    async def put_promotion_states(self, states: list[PromotionState]) -> None:
        """Batch counterpart of put_promotion_state (a genuinely optional StoragePort extension): one INCRBY
        reserves a consecutive block of sequence numbers, then every record is written in one MULTI. No
        expectation: the only caller is an idempotent in_use -> candidate nomination pass."""
        if not states:
            return
        await self.ready()
        last: int = await self._redis.incrby(self._keys.promotion_seq, len(states))
        async with self._redis.pipeline(transaction=True) as pipe:
            for i, state in enumerate(states):
                _queue_indexed(
                    pipe,
                    last - len(states) + 1 + i,
                    self._keys.promotion(state.tenant, state.artifactId),
                    state.tenant,
                    self._keys.promotion_index,
                    dumps_compact(promotion_to_wire(state)),
                )
            await pipe.execute()

    async def list_promotion_states(self, tenant: str | None = None) -> list[PromotionState]:
        await self.ready()
        return await self._list_indexed(self._keys.promotion_index(tenant), promotion_from_wire)

    # -- Fixation ---------------------------------------------------------------------------------------------

    async def get_fixation(
        self, intent_hash: str, tenant: str | None = None
    ) -> FixationRecord | None:
        await self.ready()
        raw: str | None = await self._redis.get(self._keys.fixation(tenant, intent_hash))
        return None if raw is None else _decode(raw, fixation_from_wire)

    async def put_fixation(
        self,
        record: FixationRecord,
        *,
        if_present: bool = False,
        expected_revision: ExpectedRevision = UNSET,
    ) -> None:
        await self.ready()
        key = self._keys.fixation(record.tenant, record.intentHash)
        value = dumps_compact(fixation_to_wire(record))
        if expected_revision is not UNSET:
            # if_present + None is contradictory ("must exist" and "must not exist"): always a conflict.
            if if_present and expected_revision is None:
                raise StorageConflictError("fixation", record.intentHash)

            def build(current: str | None, pipe: Any, seq: int) -> Literal["skip"] | None:
                # if_present first: an absent record is a silent no-op even when a str was expected.
                if if_present and current is None:
                    return "skip"
                _check_revision("fixation", record.intentHash, current, expected_revision)
                _queue_indexed(pipe, seq, key, record.tenant, self._keys.fixation_index, value)
                return None

            await self._write_cas(
                "fixation", record.intentHash, key, build, self._keys.fixation_seq
            )
            return
        if if_present:
            # XX: only overwrite an existing key. The indexes already contain it, so nothing else to do.
            await self._redis.set(key, value, xx=True)
            return
        await self._put_indexed(
            self._keys.fixation_seq, key, record.tenant, self._keys.fixation_index, value
        )

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]:
        await self.ready()
        return await self._list_indexed(self._keys.fixation_index(tenant), fixation_from_wire)

    async def delete_fixation(
        self,
        intent_hash: str,
        tenant: str | None = None,
        *,
        expected_revision: ExpectedDeleteRevision = UNSET,
    ) -> None:
        await self.ready()
        key = self._keys.fixation(tenant, intent_hash)

        def queue_delete(pipe: Any) -> None:
            pipe.delete(key)
            pipe.zrem(self._keys.fixation_index(None), key)
            if normalize_tenant(tenant) is not None:
                pipe.zrem(self._keys.fixation_index(tenant), key)

        if expected_revision is not UNSET:

            def build(current: str | None, pipe: Any, _seq: int) -> Literal["skip"] | None:
                _check_revision("fixation", intent_hash, current, expected_revision)
                queue_delete(pipe)
                return None

            await self._write_cas("fixation", intent_hash, key, build)
            return
        async with self._redis.pipeline(transaction=True) as pipe:
            queue_delete(pipe)
            await pipe.execute()

    # -- Helpers ----------------------------------------------------------------------------------------------

    async def _put_indexed(
        self,
        seq_key: str,
        key: str,
        tenant: str | None,
        index_key: Callable[[str | None], str],
        value: str,
    ) -> None:
        """Writes one record and registers its key in the all-tenants index and (when tenant-scoped) the
        per-tenant index."""
        seq: int = await self._redis.incr(seq_key)
        async with self._redis.pipeline(transaction=True) as pipe:
            _queue_indexed(pipe, seq, key, tenant, index_key, value)
            await pipe.execute()

    async def _list_indexed[T](
        self, index_key: str, from_wire: Callable[[dict[str, Any]], T]
    ) -> list[T]:
        """Reads every record an index points at, in index (first-insertion) order."""
        member_keys: list[str] = await self._redis.zrange(index_key, 0, -1)
        if not member_keys:
            return []
        raws: list[str | None] = await self._redis.mget(member_keys)
        out: list[T] = []
        for raw in raws:
            if raw is None:
                continue
            out.append(_decode(raw, from_wire))
        return out

    async def _write_cas(
        self,
        kind: Literal["promotion", "fixation"],
        record_id: str,
        key: str,
        build: _Build,
        seq_key: str | None = None,
    ) -> None:
        """One optimistic transaction on `key`: WATCH key, GET key, run `build` against the current body (it queues
        the writes on the MULTI and raises `StorageConflictError` to abort, or returns "skip" to write nothing),
        then EXEC. redis-py raises `WatchError("Watched variable changed.")` for the null EXEC reply of TS -- the watched
        key changed between the WATCH and the EXEC -- and only that is a conflict. `seq_key`, when given, reserves one sequence number for `build`
        (the index insertion order); it is wasted on a conflict, like every other sequence reservation here.

        redis-py has no equivalent of the TS adapter's reconnect epoch because it needs none: the TS dedicated
        connection auto-reconnects, so it has to notice a reconnect between WATCH and EXEC itself, while redis-py
        raises on the dead watching connection instead of continuing on a new one.

        WATCH state belongs to a connection, and an EXEC from any other MULTI on the same connection would clear
        it. The TS adapter therefore opens a dedicated connection and serializes the transactions on it with a
        mutex; redis-py's `Pipeline.watch` instead pins a pooled connection to the pipeline for the whole
        transaction, which is the same isolation (each transaction has a connection of its own, concurrent ones
        never share a WATCH), so no mutex is needed. The `async with` resets the pipeline on every exit path
        (UNWATCH, release), including a conflict raised before EXEC.
        """
        try:
            async with self._redis.pipeline(transaction=True) as pipe:
                await pipe.watch(key)
                current: str | None = await pipe.get(key)
                seq: int = await pipe.incr(seq_key) if seq_key is not None else 0
                pipe.multi()
                if build(current, pipe, seq) == "skip":
                    return
                await pipe.execute()
        except WatchError as error:
            if str(error) == _WATCHED_KEY_CHANGED:
                # The null EXEC reply: the watched key changed between the WATCH and the EXEC, nothing was applied.
                raise StorageConflictError(kind, record_id) from error
            # redis-py also raises WatchError when a ConnectionError / TimeoutError hit the pinned connection while
            # it was watching (it disconnects and never retries or re-sends on a watching pipeline, so a transaction
            # can not silently run on a fresh connection). That is an infrastructure failure, not a conflict, and it
            # may have struck after EXEC reached the server -- the write can already be applied -- so it must not be
            # reported as "conflict, nothing was modified": re-raise the underlying communication error.
            cause = error.__context__
            if isinstance(cause, Exception):
                raise cause from error
            raise


def _decode[T](raw: str, from_wire: Callable[[dict[str, Any]], T]) -> T:
    """Parses a stored record. A record that does not parse (corrupted or hand-edited) raises, like the TS adapter's
    `JSON.parse`, in every read path: silently skipping would hide data loss from a listing."""
    return from_wire(json.loads(raw))


def create_redis_storage_port(
    *,
    url: str | None = None,
    client: Redis | None = None,
    key_prefix: str = DEFAULT_KEY_PREFIX,
    connect_timeout_ms: int = DEFAULT_CONNECT_TIMEOUT_MS,
    command_timeout_ms: int = DEFAULT_COMMAND_TIMEOUT_MS,
) -> RedisStoragePort:
    """Creates a Redis-backed StoragePort (TS: createRedisStoragePort).

    ``url``: a redis-py connection URL (``redis://…`` / ``rediss://…``); mutually exclusive with ``client``.
    ``client``: an existing ``redis.asyncio.Redis`` to share (created with ``decode_responses=True``); `close()`
    then leaves it connected. ``key_prefix``: default "kohaku" (see keys.py for the layout).
    ``connect_timeout_ms`` bounds `ready()` / the initial connection; ``command_timeout_ms`` is redis-py's
    ``socket_timeout`` for an owned client (ignored for an injected one, whose options are never overridden).

    A redis-py client belongs to the event loop it first ran a command on: create and use one port inside one
    ``asyncio.run`` (a host assembling its app in one loop and serving in another needs to build the port in the
    serving loop).
    """
    connection = create_redis_connection(
        url=url,
        client=client,
        connect_timeout_ms=connect_timeout_ms,
        command_timeout_ms=command_timeout_ms,
        label="redis storage port",
    )
    return RedisStoragePort(connection, key_prefix)

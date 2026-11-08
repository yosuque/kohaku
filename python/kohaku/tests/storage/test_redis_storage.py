"""Redis-backed tests beyond the shared StoragePort contract (port of packages/storage-redis/test/{lineage,
lineage-scan,lineage-page,lineage-union-bounds,lineage-idempotent,snapshots,spec-cache,compare-and-set}.test.ts).
They need a real Redis (see `_backend.py`; skipped without one) because they inspect raw keys and TTLs, seed past
the scan chunk boundary, or race two port instances.
"""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest
from redis.asyncio import Redis

from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    LineagePageRequest,
    Principal,
    PromotionState,
    StorageConflictError,
    UISpec,
)
from kohaku.storage._wire import dumps_compact
from kohaku.storage.redis import create_redis_storage_port, redis_keys
from kohaku.storage.redis.lineage import LINEAGE_SCAN_CHUNK_SIZE, read_lineage_page


def _prefix() -> str:
    return f"t{secrets.token_hex(6)}"


def _run[T](awaitable: Awaitable[T]) -> T:
    async def wrapper() -> T:
        return await awaitable

    return asyncio.run(wrapper())


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
    ts: str = "2026-01-01T00:00:00.000Z",
    type_: str = "view.composed",
    payload: dict[str, Any] | None = None,
    tenant: str | None = None,
) -> LineageEventRecord:
    return LineageEventRecord(
        id=event_id,
        ts=ts,
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload or {},
        tenant=tenant,
    )


def _ts(seq: int) -> str:
    return (datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=seq)).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )


def _seq_ev(
    seq: int,
    type_: str = "view.composed",
    payload: dict[str, Any] | None = None,
    tenant: str | None = None,
    width: int = 5,
) -> LineageEventRecord:
    """Event number `seq`: ids sort by seq, timestamps are one second apart."""
    return _ev(f"{type_}-{seq:0{width}d}", ts=_ts(seq), type_=type_, payload=payload, tenant=tenant)


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
    intent_hash: str, tenant: str | None = None, fingerprint: str = "fp1"
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
    )


async def _promo(port: Any, artifact_id: str, tenant: str | None = None) -> PromotionState:
    state = await port.get_promotion_state(artifact_id, tenant)
    assert state is not None
    return cast(PromotionState, state)


async def _fix(port: Any, intent_hash: str, tenant: str | None = None) -> FixationRecord:
    record = await port.get_fixation(intent_hash, tenant)
    assert record is not None
    return cast(FixationRecord, record)


class TestSpecCache:
    def test_stores_and_returns_a_spec_by_key_and_none_for_an_unknown_key(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                await port.put_spec_cache("k1", _spec("k1"))
                assert await port.get_spec_cache("k1") == _spec("k1")
                assert await port.get_spec_cache("nope") is None
            finally:
                await port.close()

        _run(go())

    def test_applies_ttl_seconds_as_a_redis_expiry_and_keeps_an_entry_without_ttl_forever(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            port = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            raw = Redis.from_url(redis_url, decode_responses=True)
            try:
                await port.put_spec_cache("ttl", _spec("ttl"), ttl_seconds=100)
                ttl = await raw.ttl(f"{prefix}:spec:ttl")
                assert 0 < ttl <= 100
                await port.put_spec_cache("forever", _spec("forever"))
                assert await raw.ttl(f"{prefix}:spec:forever") == -1
            finally:
                await raw.aclose()
                await port.close()

        _run(go())

    def test_is_shared_across_two_port_instances_on_the_same_redis(self, redis_url: str) -> None:
        async def go() -> None:
            prefix = _prefix()
            a = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            b = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            try:
                await a.put_spec_cache("shared", _spec("shared"))
                assert await b.get_spec_cache("shared") == _spec("shared")
            finally:
                await a.close()
                await b.close()

        _run(go())

    def test_close_on_an_injected_client_leaves_that_client_connected(self, redis_url: str) -> None:
        async def go() -> None:
            client = Redis.from_url(redis_url, decode_responses=True)
            injected = create_redis_storage_port(client=client, key_prefix=_prefix())
            try:
                await injected.put_spec_cache("k", _spec("k"))
                await injected.close()
                assert await client.ping() is True
            finally:
                await client.aclose()

        _run(go())

    def test_stores_the_spec_as_compact_json_text(self, redis_url: str) -> None:
        async def go() -> None:
            prefix = _prefix()
            port = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            raw = Redis.from_url(redis_url, decode_responses=True)
            try:
                await port.put_spec_cache("k", _spec("k"))
                text = await raw.get(f"{prefix}:spec:k")
                assert text == dumps_compact(_spec("k").to_wire())
                assert (
                    ", " not in text.split('"provenance"')[0]
                )  # compact separators, as JSON.stringify
            finally:
                await raw.aclose()
                await port.close()

        _run(go())


class TestLineage:
    def test_lineage_reads_filters_and_round_trips(self, redis_url: str) -> None:
        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                await port.append_lineage(
                    _ev(
                        "01",
                        ts="2026-01-01T00:00:01.000Z",
                        payload={"intentHash": "h1", "artifactId": "a1"},
                        tenant="acme",
                    )
                )
                await port.append_lineage(
                    _ev(
                        "02",
                        ts="2026-01-01T00:00:02.000Z",
                        type_="component.generated",
                        payload={"artifactId": "a1"},
                    )
                )
                await port.append_lineage(
                    _ev(
                        "03",
                        ts="2026-01-01T00:00:03.000Z",
                        payload={"intentHash": "h2", "specHash": "s3"},
                        tenant="globex",
                    )
                )
                await port.append_lineage(
                    _ev(
                        "04",
                        ts="2026-01-01T00:00:04.000Z",
                        payload={"intentHash": "h1"},
                        tenant="acme",
                    )
                )

                def ids(events: list[LineageEventRecord]) -> list[str]:
                    return [e.id for e in events]

                assert ids(await port.list_lineage()) == ["01", "02", "03", "04"]
                assert ids(await port.list_lineage(LineageFilter(intentHash="h1"))) == ["01", "04"]
                assert ids(await port.list_lineage(LineageFilter(artifactId="a1"))) == ["01", "02"]
                assert ids(await port.list_lineage(LineageFilter(specHash="s3"))) == ["03"]
                assert ids(await port.list_lineage(LineageFilter(tenant="acme"))) == ["01", "04"]
                assert ids(
                    await port.list_lineage(LineageFilter(type=["component.generated"]))
                ) == ["02"]
                assert ids(
                    await port.list_lineage(
                        LineageFilter(type=["component.generated", "view.composed"])
                    )
                ) == ["01", "02", "03", "04"]
                # An empty type list matches nothing (the file / postgres ports' `x in []` semantics).
                assert await port.list_lineage(LineageFilter(type=[])) == []
                # An indexed predicate ANDed with the remaining ones.
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
                # until applies before the tail slice, and limit <= 0 is empty.
                assert ids(
                    await port.list_lineage(
                        LineageFilter(until="2026-01-01T00:00:02.000Z", limit=1)
                    )
                ) == ["02"]
                assert await port.list_lineage(LineageFilter(limit=0)) == []
                assert ids(await port.list_lineage(LineageFilter(limit=2))) == ["03", "04"]
                # The whole record (actor / payload / tenant) round-trips.
                (first,) = await port.list_lineage(LineageFilter(intentHash="h1", limit=1))
                assert first == _ev(
                    "04",
                    ts="2026-01-01T00:00:04.000Z",
                    payload={"intentHash": "h1"},
                    tenant="acme",
                )
            finally:
                await port.close()

        _run(go())


class TestAppendLineageIdempotency:
    """`append_lineage`'s atomicity/idempotency inspected directly against raw Redis state."""

    def test_a_fresh_append_is_fully_indexed_with_the_ts_shaped_body(self, redis_url: str) -> None:
        async def go() -> None:
            prefix = _prefix()
            keys = redis_keys(prefix)
            port = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            raw = Redis.from_url(redis_url, decode_responses=True)
            try:
                event = _ev("e1", payload={"intentHash": "h1"}, tenant="acme")
                await port.append_lineage(event)
                # Byte-for-byte what `JSON.stringify` of the TS record is (compact, TS key order).
                assert await raw.hget(keys.lineage.events, "e1") == (
                    '{"id":"e1","ts":"2026-01-01T00:00:00.000Z","actor":{"kind":"system"},'
                    '"type":"view.composed","payload":{"intentHash":"h1"},"tenant":"acme"}'
                )
                assert await raw.zscore(keys.lineage.by_seq, "e1") is not None
                assert (
                    await raw.zscore(keys.lineage.index("type", "view.composed"), "e1") is not None
                )
                assert await raw.zscore(keys.lineage.index("tenant", "acme"), "e1") is not None
                assert await raw.zscore(keys.lineage.index("intentHash", "h1"), "e1") is not None
            finally:
                await raw.aclose()
                await port.close()

        _run(go())

    def test_a_duplicate_append_with_the_same_payload_is_a_full_no_op(self, redis_url: str) -> None:
        async def go() -> None:
            prefix = _prefix()
            keys = redis_keys(prefix)
            port = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            raw = Redis.from_url(redis_url, decode_responses=True)
            try:
                event = _ev("e2", payload={"intentHash": "h1"}, tenant="acme")
                await port.append_lineage(event)
                zsets = [
                    keys.lineage.by_seq,
                    keys.lineage.index("type", "view.composed"),
                    keys.lineage.index("tenant", "acme"),
                    keys.lineage.index("intentHash", "h1"),
                ]
                body_before = await raw.hget(keys.lineage.events, "e2")
                scores_before = [await raw.zscore(z, "e2") for z in zsets]
                await port.append_lineage(event)  # identical retry: same id, same payload
                assert await raw.hget(keys.lineage.events, "e2") == body_before
                assert [await raw.zscore(z, "e2") for z in zsets] == scores_before
            finally:
                await raw.aclose()
                await port.close()

        _run(go())

    def test_a_duplicate_id_with_a_different_payload_never_overwrites_the_stored_body(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            keys = redis_keys(prefix)
            port = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            raw = Redis.from_url(redis_url, decode_responses=True)
            try:
                await port.append_lineage(_ev("e3", payload={"intentHash": "h1"}, tenant="acme"))
                body_before = await raw.hget(keys.lineage.events, "e3")
                await port.append_lineage(
                    _ev("e3", payload={"intentHash": "mutated"}, tenant="acme")
                )
                assert await raw.hget(keys.lineage.events, "e3") == body_before
            finally:
                await raw.aclose()
                await port.close()

        _run(go())


class TestLineageScanAndPushdown:
    def test_a_filter_fully_expressed_by_its_index_reads_only_the_newest_limit_events(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                total, limit = 20, 3
                for i in range(total):
                    await port.append_lineage(_seq_ev(i, tenant="acme-pushdown"))
                result = await port.list_lineage(LineageFilter(tenant="acme-pushdown", limit=limit))
                assert [e.id for e in result] == [
                    _seq_ev(total - limit + i).id for i in range(limit)
                ]
            finally:
                await port.close()

        _run(go())

    def test_a_filter_not_fully_expressed_by_its_index_scans_in_chunks_past_the_boundary(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                total = LINEAGE_SCAN_CHUNK_SIZE + 20
                matching = 5
                for i in range(total):
                    await port.append_lineage(_seq_ev(i, tenant="globex-scan"))
                since = _seq_ev(total - matching).ts
                result = await port.list_lineage(LineageFilter(tenant="globex-scan", since=since))
                assert [e.id for e in result] == [
                    _seq_ev(total - matching + i).id for i in range(matching)
                ]
            finally:
                await port.close()

        _run(go())


class _CommandSpy:
    """Records the (key, start, stop) of every ZREVRANGE and the key of every ZRANGEBYSCORE / the ids of every HMGET
    that reach a real redis-py client, whether called on the client or queued on one of its pipelines."""

    def __init__(self, redis_client: Redis) -> None:
        client: Any = redis_client
        self.zrevrange: list[tuple[str, int, int]] = []
        self.zrangebyscore: list[str] = []
        self.hmget: list[list[str]] = []
        spy = self

        def wrap_zrevrange(original: Callable[..., Any]) -> Callable[..., Any]:
            def zrevrange(name: str, start: int, end: int, *a: Any, **k: Any) -> Any:
                spy.zrevrange.append((name, int(start), int(end)))
                return original(name, start, end, *a, **k)

            return zrevrange

        original_zrevrange = client.zrevrange
        client.zrevrange = wrap_zrevrange(original_zrevrange)

        original_zrangebyscore = client.zrangebyscore

        def zrangebyscore(name: str, *a: Any, **k: Any) -> Any:
            spy.zrangebyscore.append(name)
            return original_zrangebyscore(name, *a, **k)

        client.zrangebyscore = zrangebyscore

        original_hmget = client.hmget

        def hmget(name: str, keys: list[str], *a: Any) -> Any:
            spy.hmget.append(list(keys))
            return original_hmget(name, keys, *a)

        client.hmget = hmget

        original_pipeline = client.pipeline

        def pipeline(*a: Any, **k: Any) -> Any:
            pipe = original_pipeline(*a, **k)
            pipe.zrevrange = wrap_zrevrange(pipe.zrevrange)
            return pipe

        client.pipeline = pipeline


class TestLineagePage:
    def test_continues_scanning_across_more_than_one_chunk_within_a_single_page(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                total = LINEAGE_SCAN_CHUNK_SIZE * 2 + 5
                for i in range(total):
                    # Only the very last event matches; every chunk before it must be scanned and discarded.
                    await port.append_lineage(
                        _seq_ev(
                            i,
                            tenant="chunked",
                            payload={"correlationId": "only-match"} if i == total - 1 else None,
                        )
                    )
                page = await port.page_lineage(
                    LineagePageRequest(tenant="chunked", correlationId="only-match")
                )
                assert [e.id for e in page.events] == [_seq_ev(total - 1).id]
                assert page.nextCursor is None
            finally:
                await port.close()

        _run(go())

    def test_pages_forward_across_a_chunk_boundary_with_no_gaps_or_duplicates(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                total = LINEAGE_SCAN_CHUNK_SIZE + 10
                for i in range(total):
                    await port.append_lineage(_seq_ev(i))
                collected: list[str] = []
                cursor: str | None = None
                while True:
                    page = await port.page_lineage(LineagePageRequest(pageSize=300, cursor=cursor))
                    collected.extend(e.id for e in page.events)
                    if page.nextCursor is None:
                        break
                    cursor = page.nextCursor
                assert collected == [_seq_ev(i).id for i in range(total)]
            finally:
                await port.close()

        _run(go())

    def test_reads_a_selective_filter_off_its_field_index_not_the_whole_by_seq_log(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            client = Redis.from_url(redis_url, decode_responses=True)
            port = create_redis_storage_port(client=client, key_prefix=prefix)
            try:
                total = LINEAGE_SCAN_CHUNK_SIZE * 2 + 50
                wanted = [7, 600, total - 1]
                for i in range(total):
                    await port.append_lineage(
                        _seq_ev(i, payload={"correlationId": "c1"} if i in wanted else None)
                    )
                spy = _CommandSpy(client)
                page = await port.page_lineage(LineagePageRequest(correlationId="c1"))
                assert [e.id for e in page.events] == [_seq_ev(i).id for i in wanted]
                assert page.nextCursor is None
                keys = redis_keys(prefix)
                assert spy.zrangebyscore == [keys.lineage.index("correlationId", "c1")]
                # Only the three indexed ids were hydrated: not one of the unrelated events.
                assert sum(len(ids) for ids in spy.hmget) == len(wanted)
            finally:
                await client.aclose()

        _run(go())

    def test_uses_the_by_seq_log_when_the_filter_has_no_single_value_index(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            client = Redis.from_url(redis_url, decode_responses=True)
            port = create_redis_storage_port(client=client, key_prefix=prefix)
            try:
                await port.append_lineage(_seq_ev(1, type_="a"))
                await port.append_lineage(_seq_ev(2, type_="b"))
                await port.append_lineage(_seq_ev(3, type_="c"))
                spy = _CommandSpy(client)
                page = await port.page_lineage(LineagePageRequest(type=["a", "c"]))
                assert [e.id for e in page.events] == [
                    _seq_ev(1, type_="a").id,
                    _seq_ev(3, type_="c").id,
                ]
                assert spy.zrangebyscore == [redis_keys(prefix).lineage.by_seq]
            finally:
                await client.aclose()

        _run(go())

    def test_stops_after_the_per_call_chunk_budget_with_a_short_page_and_a_resumable_cursor(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            client = Redis.from_url(redis_url, decode_responses=True)
            port = create_redis_storage_port(client=client, key_prefix=prefix)
            try:
                total = LINEAGE_SCAN_CHUNK_SIZE * 2 + 20
                for i in range(total):
                    # Every event is tenant-scoped (so the filter has an index); only the last matches the rest.
                    await port.append_lineage(
                        _seq_ev(
                            i,
                            tenant="t",
                            payload={"artifactId": "a1"} if i == total - 1 else None,
                        )
                    )
                keys = redis_keys(prefix)
                # artifactId is the more selective candidate, so a budget of one chunk is enough there ...
                via_index = await read_lineage_page(
                    client, keys, LineagePageRequest(tenant="t", artifactId="a1"), 1
                )
                assert [e.id for e in via_index.events] == [_seq_ev(total - 1).id]

                # ... while a filter that can only scan the tenant index runs out of budget, pages short, resumes.
                collected: list[str] = []
                pages = 0
                cursor: str | None = None
                saw_empty_page_with_cursor = False
                while True:
                    page = await read_lineage_page(
                        client,
                        keys,
                        LineagePageRequest(tenant="t", since=_seq_ev(total - 1).ts, cursor=cursor),
                        1,
                    )
                    pages += 1
                    collected.extend(e.id for e in page.events)
                    if page.nextCursor is None:
                        break
                    if not page.events:
                        saw_empty_page_with_cursor = True
                    cursor = page.nextCursor
                assert collected == [_seq_ev(total - 1).id]
                assert pages == 3
                assert saw_empty_page_with_cursor
            finally:
                await client.aclose()

        _run(go())


class TestMultiValueTypeUnionBounds:
    def test_union_reads_never_issue_an_unbounded_zrevrange(self, redis_url: str) -> None:
        async def go() -> None:
            client = Redis.from_url(redis_url, decode_responses=True)
            port = create_redis_storage_port(client=client, key_prefix=_prefix())
            try:
                spy = _CommandSpy(client)
                # (1) an exhaustive multi-type filter reads at most `limit` entries per type. All of "a" is
                # appended before all of "b", so the newest `limit` events overall are exactly the newest `limit`
                # "b" events -- the expected merge needs no score arithmetic here.
                per_type = 30
                for i in range(per_type):
                    await port.append_lineage(_seq_ev(i, type_="a", width=4))
                for i in range(per_type):
                    await port.append_lineage(_seq_ev(1000 + i, type_="b", width=4))
                limit = 10
                spy.zrevrange.clear()
                result = await port.list_lineage(LineageFilter(type=["a", "b"], limit=limit))
                type_calls = [c for c in spy.zrevrange if ":idx:type:" in c[0]]
                assert type_calls
                for _, start, stop in type_calls:
                    assert stop != -1  # never the unbounded "read the whole index" form
                    assert stop - start + 1 <= limit
                assert len(result) == limit
                assert all(e.type == "b" for e in result)
                assert [e.id for e in result] == [
                    _seq_ev(1000 + per_type - limit + i, type_="b", width=4).id
                    for i in range(limit)
                ]

                # (2) a non-exhaustive multi-type filter (type + since) never issues an unbounded ZREVRANGE either.
                spy.zrevrange.clear()
                since = _seq_ev(1000 + 25, type_="b", width=4).ts
                result = await port.list_lineage(LineageFilter(type=["a", "b"], since=since))
                type_calls = [c for c in spy.zrevrange if ":idx:type:" in c[0]]
                assert type_calls
                for _, start, stop in type_calls:
                    assert stop != -1
                    assert stop - start + 1 <= LINEAGE_SCAN_CHUNK_SIZE
                assert [e.id for e in result] == [
                    _seq_ev(1000 + i, type_="b", width=4).id for i in (25, 26, 27, 28, 29)
                ]

                # (3) an empty filter (limit only, no usable index) takes the by-seq `limit` pushdown, never the
                # chunked scan -- the shape the admin Lineage tab and GET /analytics/summary issue.
                for i in range(20):
                    await port.append_lineage(_seq_ev(2000 + i, type_="c", width=4))
                limit = 7
                spy.zrevrange.clear()
                result = await port.list_lineage(LineageFilter(limit=limit))
                by_seq_calls = [c for c in spy.zrevrange if c[0].endswith(":lineage:by-seq")]
                assert len(by_seq_calls) == 1
                assert by_seq_calls[0][1:] == (0, limit - 1)
                assert [e.id for e in result] == [
                    _seq_ev(2000 + 20 - limit + i, type_="c", width=4).id for i in range(limit)
                ]
            finally:
                await client.aclose()

        _run(go())


class TestPromotionStateAndFixation:
    def test_promotion_state_and_fixation_behaviour_beyond_the_shared_contract(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                # Separates promotion state by (tenant, artifactId); tenant-neutral only without a tenant.
                await port.put_promotion_state(_state("a1"))
                await port.put_promotion_state(_state("a1", "acme", "published"))
                assert (await _promo(port, "a1")).status == "candidate"
                assert (await _promo(port, "a1", "acme")).status == "published"
                assert await port.get_promotion_state("a1", "globex") is None
                assert [(s.artifactId, s.tenant) for s in await port.list_promotion_states()] == [
                    ("a1", None),
                    ("a1", "acme"),
                ]
                assert [s.status for s in await port.list_promotion_states("acme")] == ["published"]

                # An empty-string tenant is the same as an omitted one.
                await port.put_promotion_state(_state("empty-tenant", ""))
                stored = await port.get_promotion_state("empty-tenant")
                assert stored is not None
                assert await port.get_promotion_state("empty-tenant", "") == stored

                # First-insertion order survives an overwrite.
                await port.put_promotion_state(_state("a2", "acme"))
                await port.put_promotion_state(_state("a1", "acme", "withdrawn"))
                assert [s.artifactId for s in await port.list_promotion_states("acme")] == [
                    "a1",
                    "a2",
                ]

                # The batch write.
                await port.put_promotion_states([_state("b1", "globex"), _state("b2", "globex")])
                assert [s.artifactId for s in await port.list_promotion_states("globex")] == [
                    "b1",
                    "b2",
                ]
                await port.put_promotion_states([])  # no-op

                # Fixations: separated by (tenant, intentHash), listed per tenant.
                await port.put_fixation(_fixation("h1"))
                await port.put_fixation(_fixation("h1", "acme"))
                assert (await _fix(port, "h1")).tenant is None
                assert (await _fix(port, "h1", "acme")).tenant == "acme"
                assert await port.get_fixation("h1", "globex") is None
                assert len(await port.list_fixations()) == 2
                assert len(await port.list_fixations("acme")) == 1

                # if_present: a no-op when absent, an update when present.
                await port.put_fixation(_fixation("h9", "acme"), if_present=True)
                assert await port.get_fixation("h9", "acme") is None
                assert len(await port.list_fixations("acme")) == 1
                await port.put_fixation(_fixation("h1", "acme", "fp2"), if_present=True)
                assert (await _fix(port, "h1", "acme")).catalogFingerprint == "fp2"

                # delete_fixation removes the record from both indexes, and is idempotent.
                await port.delete_fixation("h1", "acme")
                assert await port.get_fixation("h1", "acme") is None
                assert len(await port.list_fixations("acme")) == 0
                assert len(await port.list_fixations()) == 1
                await port.delete_fixation("h1", "acme")
            finally:
                await port.close()

        _run(go())

    def test_declares_the_optional_extensions(self, redis_url: str) -> None:
        port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
        assert callable(port.put_promotion_states)
        assert callable(port.delete_fixation)
        assert callable(port.page_lineage)
        assert port.supports_compare_and_set is True

    def test_a_corrupt_stored_record_raises_in_every_read_path_like_the_ts_adapter(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            keys = redis_keys(prefix)
            port = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            raw = Redis.from_url(redis_url, decode_responses=True)
            try:
                await port.put_fixation(_fixation("good"))
                bad_key = keys.fixation(None, "bad")
                await raw.set(bad_key, "{not json")
                await raw.zadd(keys.fixation_index(None), {bad_key: 999})
                with pytest.raises(ValueError):
                    await port.get_fixation("bad")
                with pytest.raises(ValueError):
                    await port.list_fixations()
                bad_state = keys.promotion(None, "bad")
                await raw.set(bad_state, "nope")
                with pytest.raises(ValueError):
                    await port.get_promotion_state("bad")
                # A lineage body that is not JSON raises from the hydrate path as well.
                await raw.hset(keys.lineage.events, "bad", "{")
                await raw.zadd(keys.lineage.by_seq, {"bad": 9999})
                with pytest.raises(ValueError):
                    await port.list_lineage()
            finally:
                await raw.aclose()
                await port.close()

        _run(go())


class TestCompareAndSetAcrossInstances:
    """Two ports on the same backend and key prefix stand in for two host instances: they share no in-process lock,
    so only WATCH / MULTI / EXEC can make exactly one of two writes from the same base win. The shared contract
    only races writes through ONE port instance."""

    def test_lets_exactly_one_of_two_instances_win_a_write_from_the_same_base_every_round(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            a = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            b = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            try:
                for round_ in range(25):
                    base = f"base{round_}"
                    await a.put_promotion_state(_state("a1", revision=base))
                    settled = await asyncio.gather(
                        a.put_promotion_state(
                            _state("a1", status="approved", revision=f"a{round_}"),
                            expected_revision=base,
                        ),
                        b.put_promotion_state(
                            _state("a1", status="rejected", revision=f"b{round_}"),
                            expected_revision=base,
                        ),
                        return_exceptions=True,
                    )
                    losers = [r for r in settled if isinstance(r, BaseException)]
                    assert len(losers) == 1
                    assert isinstance(losers[0], StorageConflictError)
                    stored = await a.get_promotion_state("a1")
                    assert stored is not None
                    assert stored.revision in (f"a{round_}", f"b{round_}")
            finally:
                await a.close()
                await b.close()

        _run(go())

    def test_plain_writes_interleaved_with_cas_writes_do_not_clear_a_pending_watch(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            prefix = _prefix()
            a = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            b = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            try:
                await a.put_promotion_state(_state("a1", revision="r1"))
                noise = [
                    a.put_promotion_state(_state(f"n{i}", revision=f"n{i}")) for i in range(20)
                ]
                results = await asyncio.gather(
                    *noise,
                    b.put_promotion_state(
                        _state("a1", status="approved", revision="r2"), expected_revision="r1"
                    ),
                    a.put_promotion_state(
                        _state("a1", status="rejected", revision="r3"), expected_revision="r1"
                    ),
                    return_exceptions=True,
                )
                cas = results[-2:]
                assert len([r for r in cas if not isinstance(r, BaseException)]) == 1
                assert len([r for r in results[:-2] if isinstance(r, BaseException)]) == 0
            finally:
                await a.close()
                await b.close()

        _run(go())

    def test_close_is_idempotent_for_url_constructed_ports_that_used_compare_and_set(
        self, redis_url: str
    ) -> None:
        async def go() -> None:
            a = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            await a.put_promotion_state(_state("a1", revision="r1"), expected_revision=None)
            await a.close()
            await a.close()

        _run(go())

    def test_a_conditional_write_releases_its_pooled_connection(self, redis_url: str) -> None:
        """WATCH pins a pooled connection to its pipeline; every exit path (success, conflict, if_present skip) must
        hand it back, or a busy host would leak one connection per conditional write."""

        async def go() -> None:
            client = Redis.from_url(redis_url, decode_responses=True)
            port = create_redis_storage_port(client=client, key_prefix=_prefix())
            try:
                await port.put_promotion_state(_state("a1", revision="r1"), expected_revision=None)
                with pytest.raises(StorageConflictError):
                    await port.put_promotion_state(
                        _state("a1", revision="r2"), expected_revision="stale"
                    )
                await port.put_fixation(_fixation("h"), if_present=True, expected_revision="r1")
                pool = client.connection_pool
                assert len(pool._in_use_connections) == 0
            finally:
                await client.aclose()

        _run(go())


class TestCompareAndSetConnectionLoss:
    """redis-py raises `WatchError` both for a null EXEC (a genuine conflict) and for a ConnectionError / TimeoutError
    that hit the watching connection. Only the first is a `StorageConflictError`: the second may have struck after EXEC
    reached the server, so reporting it as "conflict, nothing modified" could be a lie -- the underlying communication
    error is re-raised."""

    def test_a_timeout_on_a_step_before_exec_is_reraised_not_reported_as_a_conflict(
        self, redis_url: str
    ) -> None:
        from unittest.mock import patch

        from redis.asyncio.client import Pipeline
        from redis.exceptions import TimeoutError as RedisTimeoutError
        from redis.exceptions import WatchError

        def watch_error_caused_by(cause: Exception) -> WatchError:
            try:
                try:
                    raise cause
                except Exception:
                    # redis-py raises the WatchError while handling the communication error.
                    raise WatchError(
                        "A TimeoutError occurred while watching one or more keys"
                    ) from None
            except WatchError as error:
                return error

        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            try:
                with (
                    patch.object(
                        Pipeline, "get", side_effect=watch_error_caused_by(RedisTimeoutError("t"))
                    ),
                    pytest.raises(RedisTimeoutError),
                ):
                    await port.put_promotion_state(
                        _state("a1", revision="r1"), expected_revision=None
                    )
                assert await port.get_promotion_state("a1") is None
            finally:
                await port.close()

        _run(go())

    def test_a_timeout_after_exec_reached_the_server_is_reraised_and_the_write_is_visible(
        self, redis_url: str
    ) -> None:
        """The worst case: EXEC was sent and applied, the reply timed out. The write IS applied, so "conflict,
        nothing modified" would be false; the host must see the infrastructure error instead."""
        from redis.asyncio.client import Pipeline
        from redis.exceptions import TimeoutError as RedisTimeoutError
        from redis.exceptions import WatchError

        async def go() -> None:
            port = create_redis_storage_port(url=redis_url, key_prefix=_prefix())
            original_execute = Pipeline.execute

            async def execute_then_time_out(self: Any, *args: Any, **kwargs: Any) -> Any:
                await original_execute(self, *args, **kwargs)  # applied on the server
                try:
                    raise RedisTimeoutError("reply lost")
                except RedisTimeoutError:
                    raise WatchError(
                        "A TimeoutError occurred while watching one or more keys"
                    ) from None

            try:
                with (
                    pytest.MonkeyPatch.context() as patch,
                    pytest.raises(RedisTimeoutError),
                ):
                    patch.setattr(Pipeline, "execute", execute_then_time_out)
                    await port.put_promotion_state(
                        _state("a1", revision="r1"), expected_revision=None
                    )
                stored = await port.get_promotion_state("a1")
                assert stored is not None and stored.revision == "r1"
            finally:
                await port.close()

        _run(go())

    def test_a_null_exec_is_the_conflict(self, redis_url: str) -> None:
        async def go() -> None:
            prefix = _prefix()
            a = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            try:
                await a.put_promotion_state(_state("a1", revision="r1"))
                with pytest.raises(StorageConflictError):
                    await a.put_promotion_state(
                        _state("a1", revision="r2"), expected_revision="stale"
                    )
                await a.put_promotion_state(_state("a1", revision="r2"), expected_revision="r1")
            finally:
                await a.close()

        _run(go())

    def test_a_successful_conditional_write_leaves_no_watch_behind(self, redis_url: str) -> None:
        async def go() -> None:
            client = Redis.from_url(redis_url, decode_responses=True)
            port = create_redis_storage_port(client=client, key_prefix=_prefix())
            try:
                await port.put_promotion_state(_state("a1", revision="r1"), expected_revision=None)
                # The pooled connection the transaction used is idle and un-watched: a plain write from another
                # pipeline on it cannot be aborted by a stale watch.
                await port.put_promotion_state(_state("a1", revision="r2"))
                await port.put_promotion_state(_state("a1", revision="r3"), expected_revision="r2")
                assert len(client.connection_pool._in_use_connections) == 0
            finally:
                await client.aclose()

        _run(go())


class TestCompareAndSetReconnect:
    def test_a_connection_killed_between_watch_and_exec_cannot_silently_succeed(
        self, redis_url: str
    ) -> None:
        """The reconnect-between-WATCH-and-EXEC hazard of the TS adapter (its reconnect epoch): a connection the
        server drops after the WATCH has lost the watch, so a retry of the transaction on a fresh connection would
        write against a read nothing guards. redis-py disconnects and raises on a watching pipeline instead of
        retrying; this kills the real pinned connection after the GET. Nothing was sent, nothing is written, and
        the underlying connection error (not a bogus conflict) reaches the caller."""
        from redis.asyncio.client import Pipeline
        from redis.exceptions import ConnectionError as RedisConnectionError

        async def go() -> None:
            prefix = _prefix()
            port = create_redis_storage_port(url=redis_url, key_prefix=prefix)
            killer: Any = Redis.from_url(redis_url, decode_responses=True)
            original_get = Pipeline.get

            async def get_then_kill(self: Any, name: str) -> Any:
                value = await original_get(self, name)
                client_id = await self.client_id()
                await killer.execute_command("CLIENT", "KILL", "ID", client_id)
                return value

            try:
                await port.ready()
                with (
                    pytest.MonkeyPatch.context() as patch,
                    pytest.raises(RedisConnectionError),
                ):
                    patch.setattr(Pipeline, "get", get_then_kill)
                    await port.put_promotion_state(
                        _state("a1", revision="r1"), expected_revision=None
                    )
                assert await port.get_promotion_state("a1") is None
                # The port is usable afterwards (the dead connection was discarded, not reused).
                await port.put_promotion_state(_state("a1", revision="r1"), expected_revision=None)
            finally:
                await killer.aclose()
                await port.close()

        _run(go())

"""The Redis lineage read path (port of packages/storage-redis/src/lineage.ts): the index fields, candidate-index
choice, and the bounded, chunked reads behind `list_lineage` / `page_lineage`.

Lineage is an append-only hash (`events`, id -> JSON) plus sorted sets scored by append `seq` (`by-seq` and one
per indexed field/value). The write side lives in the storage port (one MULTI per append); this module only
reads. Every read is bounded: a command never spreads an unbounded id list, and a scan stops as soon as it has
what the caller asked for.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from kohaku.spec import (
    DEFAULT_LINEAGE_LIMIT,
    LINEAGE_PAYLOAD_INDEX_FIELDS,
    LineageEventRecord,
    LineageFilter,
    LineagePage,
    LineagePageRequest,
    apply_lineage_limit,
    clamp_lineage_page_size,
    decode_seq_cursor,
    encode_seq_cursor,
    matches_lineage_filter,
    normalize_tenant,
)

from .._wire import lineage_from_wire
from .keys import RedisKeys

LINEAGE_INDEX_FIELDS = ("type", "tenant", *LINEAGE_PAYLOAD_INDEX_FIELDS)
"""Fields a lineage event is indexed by: each becomes one sorted set per distinct value, scored by append seq
(``keys.lineage.index(field, value)``). Derived from `LINEAGE_PAYLOAD_INDEX_FIELDS` (the payload fields a
`LineageFilter` can match) plus the two record-level fields `type` and `tenant` -- the set `index_values`
actually iterates, not a separate hand-kept list that could drift from it."""

LINEAGE_SCAN_CHUNK_SIZE = 500
"""How many sorted-set members (or hash fields) a single Redis round trip reads at once, whenever a read can't be
bounded by `limit` alone -- iterating an index that may hold far more members than the caller's `limit`, or
hydrating a batch of ids. Keeps every command's argument list, and every reply, to a bounded size."""

LINEAGE_PAGE_MAX_SCAN_CHUNKS = 20
"""The most `LINEAGE_SCAN_CHUNK_SIZE` chunks one `read_lineage_page` call scans before giving up on filling the
page: a selective filter over a huge log then costs a bounded amount of work per call instead of a whole-log
scan. When the cap is hit first, the page comes back short (possibly empty) with a `nextCursor` at the last
scanned seq, and the caller simply continues from it."""


@dataclass(frozen=True)
class IndexValue:
    field: str
    value: str


def index_values(event: LineageEventRecord) -> list[IndexValue]:
    """The index entries one event contributes (see `LINEAGE_INDEX_FIELDS`): always `type`; `tenant` only when
    present (after `normalize_tenant`); the payload hash fields only when they are present strings."""
    out: list[IndexValue] = []
    for field in LINEAGE_INDEX_FIELDS:
        if field == "type":
            out.append(IndexValue(field, event.type))
        elif field == "tenant":
            tenant = normalize_tenant(event.tenant)
            if tenant is not None:
                out.append(IndexValue(field, tenant))
        else:
            value = event.payload.get(field)
            if isinstance(value, str):
                out.append(IndexValue(field, value))
    return out


@dataclass(frozen=True)
class LineageIndexCandidate:
    field: str
    values: list[str]


def choose_candidate_index(
    filter: LineageFilter | LineagePageRequest,
) -> LineageIndexCandidate | None:
    """Picks the sorted set(s) to read candidate ids from, most selective first: the payload id fields
    (`LINEAGE_PAYLOAD_INDEX_FIELDS` -- typically unique or near-unique), then `type` (usually a small, bounded
    vocabulary), then `tenant` (broad: everything a tenant has ever done). ``None`` means "no usable index --
    scan `by-seq`". Every predicate not covered by the chosen candidate is still applied client-side (see
    `is_index_exhaustive` / `matches_lineage_filter`)."""
    for field in LINEAGE_PAYLOAD_INDEX_FIELDS:
        value = getattr(filter, field)
        if value is not None:
            return LineageIndexCandidate(field, [value])
    if filter.type is not None and len(filter.type) > 0:
        return LineageIndexCandidate("type", list(filter.type))
    tenant = normalize_tenant(filter.tenant)
    if tenant is not None:
        return LineageIndexCandidate("tenant", [tenant])
    return None


def is_index_exhaustive(
    filter: LineageFilter | LineagePageRequest, candidate: LineageIndexCandidate
) -> bool:
    """Whether `filter` is fully satisfied by `candidate` alone, with no other predicate (another field, or
    `since` / `until`) left to check client-side. When true, `read_lineage` can read exactly the newest `limit`
    ids straight off the index instead of scanning it chunk by chunk."""
    if filter.since is not None or filter.until is not None:
        return False
    if candidate.field != "type" and filter.type is not None and len(filter.type) > 0:
        return False
    if candidate.field != "tenant" and normalize_tenant(filter.tenant) is not None:
        return False
    return all(
        candidate.field == field or getattr(filter, field) is None
        for field in LINEAGE_PAYLOAD_INDEX_FIELDS
    )


async def _hydrate(redis: Any, keys: RedisKeys, ids: list[str]) -> list[LineageEventRecord]:
    """Fetches the JSON bodies for `ids` from the events hash, chunked (`LINEAGE_SCAN_CHUNK_SIZE`) so no single
    HMGET spreads an unbounded id list into one command. Returns events in the same order as `ids`, skipping an id
    whose body is gone (should not happen under this port's HSETNX + ZADD-NX writes; handled defensively)."""
    events: list[LineageEventRecord] = []
    for i in range(0, len(ids), LINEAGE_SCAN_CHUNK_SIZE):
        chunk = ids[i : i + LINEAGE_SCAN_CHUNK_SIZE]
        raws: list[str | None] = await redis.hmget(keys.lineage.events, chunk)
        for raw in raws:
            if raw is not None:
                events.append(lineage_from_wire(json.loads(raw)))
    return events


async def _read_pushdown(
    redis: Any, keys: RedisKeys, zset_key: str, limit: int
) -> list[LineageEventRecord]:
    """Reads exactly the newest `limit` ids off a single sorted set and hydrates them -- used only when
    `is_index_exhaustive` says the index (or `by-seq`, when there is no usable index at all) alone already
    satisfies the whole filter. ZREVRANGE returns them newest first; reversing the hydrated events puts them back
    in the append order every StoragePort promises."""
    ids: list[str] = await redis.zrevrange(zset_key, 0, limit - 1)
    if not ids:
        return []
    events = await _hydrate(redis, keys, ids)
    events.reverse()
    return events


async def _scan_for_matches(
    redis: Any, keys: RedisKeys, zset_key: str, filter: LineageFilter, limit: int
) -> list[LineageEventRecord]:
    """Scans a single sorted set (`by-seq` or one index) from the newest side in `LINEAGE_SCAN_CHUNK_SIZE` chunks,
    hydrating and filtering each chunk with `matches_lineage_filter`, and stops as soon as `limit` matches are
    collected or the set is exhausted -- so a filter whose candidate index is large but only partly selective
    never has to read every member of that index, let alone the whole event log."""
    matches: list[LineageEventRecord] = []  # collected newest-first; reversed once at the end
    start = 0
    while True:
        stop = start + LINEAGE_SCAN_CHUNK_SIZE - 1
        ids: list[str] = await redis.zrevrange(zset_key, start, stop)
        if not ids:
            break
        for event in await _hydrate(redis, keys, ids):
            if matches_lineage_filter(event, filter):
                matches.append(event)
                if len(matches) == limit:
                    matches.reverse()
                    return matches
        if len(ids) < LINEAGE_SCAN_CHUNK_SIZE:
            break  # this chunk was short: the set is exhausted
        start += LINEAGE_SCAN_CHUNK_SIZE
    matches.reverse()
    return matches


async def _read_union_pushdown(
    redis: Any, keys: RedisKeys, field: str, values: list[str], limit: int
) -> list[LineageEventRecord]:
    """Exhaustive multi-value (`type`) union: reads at most `limit` entries per value (ZREVRANGE idx 0 limit-1
    WITHSCORES, one per value, in a single pipeline round trip -- never the whole index), merges by score, and
    takes the newest `limit` overall. This is complete: any event among the true global top `limit` is
    necessarily also among its own type's top `limit`. No dedup is needed -- an event's `type` is single-valued, so
    the same id can never appear under two different values here."""
    async with redis.pipeline(transaction=False) as pipe:
        for value in values:
            pipe.zrevrange(keys.lineage.index(field, value), 0, limit - 1, withscores=True)
        results: list[list[tuple[str, float]]] = await pipe.execute()
    merged: list[tuple[str, float]] = [pair for pairs in results for pair in pairs]
    merged.sort(key=lambda m: m[1], reverse=True)
    ids = [m[0] for m in merged[:limit]]
    events = await _hydrate(redis, keys, ids)
    events.reverse()
    return events


@dataclass
class _UnionStream:
    value: str
    cursor: int
    buffer: list[tuple[str, float]]
    exhausted: bool


async def _refill_empty_streams(
    redis: Any, keys: RedisKeys, field: str, streams: list[_UnionStream]
) -> None:
    """Refills every stream whose buffer is currently empty and not yet exhausted, in a single pipeline round
    trip (a no-op, no pipeline issued, when nothing needs refilling). Each fetch is ZREVRANGE idx cursor
    cursor+LINEAGE_SCAN_CHUNK_SIZE-1 -- never an unbounded `0 -1` -- and a chunk shorter than
    `LINEAGE_SCAN_CHUNK_SIZE` marks that stream exhausted."""
    to_fill = [s for s in streams if not s.exhausted and not s.buffer]
    if not to_fill:
        return
    async with redis.pipeline(transaction=False) as pipe:
        for s in to_fill:
            pipe.zrevrange(
                keys.lineage.index(field, s.value),
                s.cursor,
                s.cursor + LINEAGE_SCAN_CHUNK_SIZE - 1,
                withscores=True,
            )
        results: list[list[tuple[str, float]]] = await pipe.execute()
    for s, items in zip(to_fill, results, strict=True):
        s.buffer = list(items)
        s.cursor += LINEAGE_SCAN_CHUNK_SIZE
        if len(items) < LINEAGE_SCAN_CHUNK_SIZE:
            s.exhausted = True


async def _read_union_scan(
    redis: Any,
    keys: RedisKeys,
    field: str,
    values: list[str],
    filter: LineageFilter,
    limit: int,
) -> list[LineageEventRecord]:
    """Non-exhaustive multi-value (`type`) union: a k-way merge across one bounded, chunked ZREVRANGE stream per
    value, always popping the globally-next id (the largest-scored buffered head across every stream) so ids come
    out in true newest-to-oldest order without ever reading an index's whole range. A stream's buffer is refilled
    -- lazily, right before the next pop decision -- the moment it runs dry and isn't yet exhausted, because a
    not-yet-fetched item from that stream could still outscore everything currently buffered elsewhere. Popped ids
    are hydrated and filtered in `LINEAGE_SCAN_CHUNK_SIZE`-sized batches purely as an I/O-batching optimization.
    Stops as soon as `limit` matches are collected or every stream is exhausted."""
    streams = [_UnionStream(value, 0, [], False) for value in values]
    matches: list[LineageEventRecord] = []
    pending: list[str] = []

    async def flush_pending() -> bool:
        nonlocal pending
        if not pending:
            return False
        ids, pending = pending, []
        for event in await _hydrate(redis, keys, ids):
            if matches_lineage_filter(event, filter):
                matches.append(event)
                if len(matches) == limit:
                    return True
        return False

    while True:
        await _refill_empty_streams(redis, keys, field, streams)
        best_index = -1
        best_score = float("-inf")
        for i, stream in enumerate(streams):
            if stream.buffer and stream.buffer[0][1] > best_score:
                best_score = stream.buffer[0][1]
                best_index = i
        if best_index == -1:
            break  # every stream is empty and exhausted: nothing left anywhere
        pending.append(streams[best_index].buffer.pop(0)[0])
        if len(pending) >= LINEAGE_SCAN_CHUNK_SIZE and await flush_pending():
            matches.reverse()
            return matches
    await flush_pending()
    matches.reverse()
    return matches


async def _read_union(
    redis: Any,
    keys: RedisKeys,
    candidate: LineageIndexCandidate,
    filter: LineageFilter,
    limit: int,
    exhaustive: bool,
) -> list[LineageEventRecord]:
    """The multi-value (`type`) union path: `_read_union_pushdown` when the filter is fully expressed by the type
    indexes alone (no other predicate), `_read_union_scan` otherwise."""
    if exhaustive:
        return await _read_union_pushdown(redis, keys, candidate.field, candidate.values, limit)
    return await _read_union_scan(redis, keys, candidate.field, candidate.values, filter, limit)


async def _read_candidate(
    redis: Any,
    keys: RedisKeys,
    candidate: LineageIndexCandidate,
    filter: LineageFilter,
    limit: int,
) -> list[LineageEventRecord]:
    exhaustive = is_index_exhaustive(filter, candidate)
    if len(candidate.values) > 1:
        return await _read_union(redis, keys, candidate, filter, limit, exhaustive)
    index_key = keys.lineage.index(candidate.field, candidate.values[0])
    if exhaustive:
        return await _read_pushdown(redis, keys, index_key, limit)
    return await _scan_for_matches(redis, keys, index_key, filter, limit)


async def read_lineage(
    redis: Any, keys: RedisKeys, filter: LineageFilter | None = None
) -> list[LineageEventRecord]:
    """`StoragePort.list_lineage`'s whole read path: chooses a candidate index (`choose_candidate_index`), reads
    it via the cheapest strategy that still satisfies the filter (`_read_pushdown` when the index alone is
    exhaustive, `_scan_for_matches` / `_read_union` otherwise, or a `by-seq` scan when there is no usable index
    at all), and returns the result in append order. `apply_lineage_limit` is still the single point that enforces
    the contract's own tail-window semantics (`DEFAULT_LINEAGE_LIMIT` when `limit` is omitted, `limit <= 0` always
    empty), the same helper every other StoragePort uses."""
    f = filter if filter is not None else LineageFilter()
    limit = f.limit if f.limit is not None else DEFAULT_LINEAGE_LIMIT
    if limit <= 0:
        return []
    # An explicit empty `type` list is a predicate no event can ever satisfy -- `matches_lineage_filter` and the
    # memory / postgres ports all agree `type=[]` means "match nothing", not "no type filter at all".
    # `choose_candidate_index` can't tell the two apart (both fall through to None), so without this check the
    # candidate-is-None branch below would treat it as the genuinely empty filter and ignore the type predicate.
    if f.type is not None and len(f.type) == 0:
        return []

    candidate = choose_candidate_index(f)
    # candidate is None when `type` / `tenant` / every payload index field is absent from the filter, so the only
    # predicates a `by-seq` read could still need to check client-side are `since` / `until`. When those are absent
    # too (the empty filter the admin Lineage tab and GET /analytics/summary issue), `by-seq` alone already
    # satisfies the whole filter, so the `limit` pushdown applies exactly as it does for a single exhaustive index.
    if candidate is None:
        if f.since is None and f.until is None:
            events = await _read_pushdown(redis, keys, keys.lineage.by_seq, limit)
        else:
            events = await _scan_for_matches(redis, keys, keys.lineage.by_seq, f, limit)
    else:
        events = await _read_candidate(redis, keys, candidate, f, limit)
    return apply_lineage_limit(events, limit)


async def _hydrate_with_seq(
    redis: Any, keys: RedisKeys, pairs: list[tuple[str, int]]
) -> list[tuple[LineageEventRecord, int]]:
    """Fetches the JSON bodies for `pairs` (id + its `by-seq` score) from the events hash and zips each body back
    up with its own seq, dropping any id whose body is gone (the same defensive skip `_hydrate` does). Order is
    preserved (ascending, since callers always feed it a ZRANGEBYSCORE ... WITHSCORES chunk)."""
    if not pairs:
        return []
    raws: list[str | None] = await redis.hmget(keys.lineage.events, [p[0] for p in pairs])
    out: list[tuple[LineageEventRecord, int]] = []
    for raw, (_, seq) in zip(raws, pairs, strict=True):
        if raw is not None:
            out.append((lineage_from_wire(json.loads(raw)), seq))
    return out


async def read_lineage_page(
    redis: Any,
    keys: RedisKeys,
    req: LineagePageRequest,
    max_scan_chunks: int = LINEAGE_PAGE_MAX_SCAN_CHUNKS,
) -> LineagePage:
    """`StoragePort.page_lineage`'s whole read path (design.md #53): scans forward from `req.cursor`'s seq
    (exclusive lower bound -- Redis's ``(seq`` syntax) in `LINEAGE_SCAN_CHUNK_SIZE`-sized ZRANGEBYSCORE ...
    WITHSCORES LIMIT chunks, hydrating and filtering each chunk with `matches_lineage_filter`. The zset scanned is
    the single-value field index `choose_candidate_index` picks for the filter (every index is scored by the
    same seq as `by-seq`, so the cursor means the same thing on either), or `by-seq` when there is none. Stops the
    moment one match past `pageSize` is found (proof a next page exists), the scanned set is exhausted, or
    `max_scan_chunks` chunks have been read. `pageSize` goes through `clamp_lineage_page_size`. A malformed
    `req.cursor` raises `LineageCursorError` before any Redis command is issued."""
    page_size = clamp_lineage_page_size(req.pageSize)
    cursor_seq = decode_seq_cursor(req.cursor) if req.cursor is not None else 0
    # `type=[]` matches nothing (see `read_lineage`); the by-seq fallback below would still find that out, but only
    # after scanning, so answer it up front.
    if req.type is not None and len(req.type) == 0:
        return LineagePage(events=[])
    candidate = choose_candidate_index(req)
    scan_key = (
        keys.lineage.index(candidate.field, candidate.values[0])
        if candidate is not None and len(candidate.values) == 1
        else keys.lineage.by_seq
    )
    matches: list[LineageEventRecord] = []
    last_match_seq = cursor_seq
    has_more = False

    chunk = 0
    while True:
        if chunk == max_scan_chunks:
            # Budget spent with more of the set possibly unread: hand back what was found and resume from the last
            # scanned seq (an exhausted set never reaches here: it breaks below on a short chunk).
            return LineagePage(events=matches, nextCursor=encode_seq_cursor(cursor_seq))
        raw: list[tuple[str, float]] = await redis.zrangebyscore(
            scan_key,
            f"({cursor_seq}",
            "+inf",
            start=0,
            num=LINEAGE_SCAN_CHUNK_SIZE,
            withscores=True,
        )
        if not raw:
            break  # the scanned set is exhausted: nothing after cursor_seq
        pairs = [(member, int(score)) for member, score in raw]
        for event, seq in await _hydrate_with_seq(redis, keys, pairs):
            if not matches_lineage_filter(event, req):
                continue
            if len(matches) == page_size:
                has_more = True
                break
            matches.append(event)
            last_match_seq = seq
        if has_more:
            break
        cursor_seq = pairs[-1][1]
        if len(pairs) < LINEAGE_SCAN_CHUNK_SIZE:
            break  # this chunk was short: the set is exhausted
        chunk += 1
    if has_more:
        return LineagePage(events=matches, nextCursor=encode_seq_cursor(last_match_seq))
    return LineagePage(events=matches)

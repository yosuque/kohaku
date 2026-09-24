import type { LineageEventRecord, LineageFilter } from "@kohaku-ui/spec-core";
import {
  applyLineageLimit,
  DEFAULT_LINEAGE_LIMIT,
  LINEAGE_PAYLOAD_INDEX_FIELDS,
  matchesLineageFilter,
  normalizeTenant,
} from "@kohaku-ui/spec-core";
import type { Redis } from "ioredis";
import type { RedisKeys } from "./keys.js";

/**
 * Fields a lineage event is indexed by: each becomes one sorted set per distinct value, scored by append
 * seq (`keys.lineage.index(field, value)`). Derived from spec-core's `LINEAGE_PAYLOAD_INDEX_FIELDS` (the
 * payload fields a `LineageFilter` can match) plus the two record-level fields `type` and `tenant` -- this
 * constant is the set `indexValues` actually iterates below, not a separate hand-kept list that could
 * drift from it.
 */
export const LINEAGE_INDEX_FIELDS = ["type", "tenant", ...LINEAGE_PAYLOAD_INDEX_FIELDS] as const;
export type LineageIndexField = (typeof LINEAGE_INDEX_FIELDS)[number];

/**
 * How many sorted-set members (or hash fields) a single Redis round trip reads at once, whenever a read
 * can't be bounded by `limit` alone -- iterating an index that may hold far more members than the
 * caller's `limit`, or hydrating a batch of ids. Keeps every command's argument list, and every reply, to
 * a bounded size instead of spreading an unbounded id array into one command.
 */
export const LINEAGE_SCAN_CHUNK_SIZE = 500;

function payloadString(event: LineageEventRecord, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

/** The index entries one event contributes (see `LINEAGE_INDEX_FIELDS`): always `type`; `tenant` only
 * when present (after `normalizeTenant`); the payload hash fields only when they are present strings. */
export function indexValues(event: LineageEventRecord): { field: LineageIndexField; value: string }[] {
  const out: { field: LineageIndexField; value: string }[] = [];
  for (const field of LINEAGE_INDEX_FIELDS) {
    if (field === "type") {
      out.push({ field, value: event.type });
    } else if (field === "tenant") {
      const tenant = normalizeTenant(event.tenant);
      if (tenant != null) out.push({ field, value: tenant });
    } else {
      const value = payloadString(event, field);
      if (value != null) out.push({ field, value });
    }
  }
  return out;
}

export interface LineageIndexCandidate {
  field: LineageIndexField;
  values: string[];
}

/**
 * Picks the sorted set(s) to read candidate ids from, most selective first: the three payload hash
 * fields (`LINEAGE_PAYLOAD_INDEX_FIELDS` -- typically unique or near-unique), then `type` (usually a
 * small, bounded vocabulary), then `tenant` (broad: everything a tenant has ever done). `null` means "no
 * usable index -- scan `by-seq`". This priority order is independent of `LINEAGE_INDEX_FIELDS`'s
 * declaration order (which instead reflects the order `indexValues` emits entries in); every predicate
 * not covered by the chosen candidate is still applied client-side (see `isIndexExhaustive` /
 * `matchesLineageFilter`).
 */
export function chooseCandidateIndex(filter: LineageFilter): LineageIndexCandidate | null {
  for (const field of LINEAGE_PAYLOAD_INDEX_FIELDS) {
    const value = filter[field];
    if (value != null) return { field, values: [value] };
  }
  if (filter.type != null && filter.type.length > 0) return { field: "type", values: [...filter.type] };
  const tenant = normalizeTenant(filter.tenant);
  if (tenant != null) return { field: "tenant", values: [tenant] };
  return null;
}

/**
 * Whether `filter` is fully satisfied by `candidate` alone, with no other predicate (another field, or
 * `since`/`until`) left to check client-side. When true, `readLineage` can read exactly the newest
 * `limit` ids straight off the index (`readPushdown` / the exhaustive `readUnion` branch) instead of
 * scanning it chunk by chunk.
 */
export function isIndexExhaustive(filter: LineageFilter, candidate: LineageIndexCandidate): boolean {
  if (filter.since != null || filter.until != null) return false;
  if (candidate.field !== "type" && filter.type != null && filter.type.length > 0) return false;
  if (candidate.field !== "tenant" && normalizeTenant(filter.tenant) != null) return false;
  for (const field of LINEAGE_PAYLOAD_INDEX_FIELDS) {
    if (candidate.field !== field && filter[field] != null) return false;
  }
  return true;
}

/**
 * Fetches the JSON bodies for `ids` from the events hash, chunked (`LINEAGE_SCAN_CHUNK_SIZE`) so no
 * single HMGET spreads an unbounded id list into one command. Returns events in the same order as `ids`,
 * skipping an id whose body is gone (should not happen under this port's HSETNX + ZADD-NX writes; handled
 * defensively, matching the reference file port).
 */
async function hydrate(redis: Redis, keys: RedisKeys, ids: string[]): Promise<LineageEventRecord[]> {
  const events: LineageEventRecord[] = [];
  for (let i = 0; i < ids.length; i += LINEAGE_SCAN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LINEAGE_SCAN_CHUNK_SIZE);
    const raws = await redis.hmget(keys.lineage.events, ...chunk);
    for (const raw of raws) if (raw != null) events.push(JSON.parse(raw) as LineageEventRecord);
  }
  return events;
}

/**
 * Reads exactly the newest `limit` ids off a single sorted set and hydrates them -- used only when
 * `isIndexExhaustive` says the index (or `by-seq`, when there is no usable index at all) alone already
 * satisfies the whole filter. `ZREVRANGE` returns them newest first; reversing the hydrated events is
 * what puts them back in the append order every StoragePort promises.
 */
async function readPushdown(
  redis: Redis,
  keys: RedisKeys,
  zsetKey: string,
  limit: number,
): Promise<LineageEventRecord[]> {
  const ids = await redis.zrevrange(zsetKey, 0, limit - 1);
  if (ids.length === 0) return [];
  return (await hydrate(redis, keys, ids)).reverse();
}

/**
 * Scans a single sorted set (`by-seq` or one index) from the newest side in `LINEAGE_SCAN_CHUNK_SIZE`
 * chunks, hydrating and filtering each chunk with `matchesLineageFilter`, and stops as soon as `limit`
 * matches are collected or the set is exhausted -- so a filter whose candidate index is large but only
 * partly selective (e.g. `type` on a busy host, further narrowed by `since`) never has to read every
 * member of that index, let alone the whole event log.
 */
async function scanForMatches(
  redis: Redis,
  keys: RedisKeys,
  zsetKey: string,
  filter: LineageFilter,
  limit: number,
): Promise<LineageEventRecord[]> {
  const matches: LineageEventRecord[] = []; // collected newest-first; reversed once at the end
  let start = 0;
  for (;;) {
    const stop = start + LINEAGE_SCAN_CHUNK_SIZE - 1;
    const ids = await redis.zrevrange(zsetKey, start, stop);
    if (ids.length === 0) break;
    for (const event of await hydrate(redis, keys, ids)) {
      if (matchesLineageFilter(event, filter)) {
        matches.push(event);
        if (matches.length === limit) return matches.reverse();
      }
    }
    if (ids.length < LINEAGE_SCAN_CHUNK_SIZE) break; // this chunk was short: the set is exhausted
    start += LINEAGE_SCAN_CHUNK_SIZE;
  }
  return matches.reverse();
}

/**
 * Exhaustive multi-value (`type`) union: reads at most `limit` entries per value (`ZREVRANGE idx 0
 * limit-1 WITHSCORES`, one per value, in a single `pipeline()` round trip -- never the whole index),
 * merges by score, and takes the newest `limit` overall. This is complete: any event among the true
 * global top `limit` is necessarily also among its own type's top `limit` (restricting to one type only
 * ever removes competitors), so `limit` entries per type can never miss a result. No dedup is needed --
 * an event's `type` is single-valued, so the same id can never appear under two different values here.
 */
async function readUnionPushdown(
  redis: Redis,
  keys: RedisKeys,
  field: LineageIndexField,
  values: string[],
  limit: number,
): Promise<LineageEventRecord[]> {
  const pipeline = redis.pipeline();
  for (const value of values)
    pipeline.zrevrange(keys.lineage.index(field, value), 0, limit - 1, "WITHSCORES");
  const results = (await pipeline.exec()) ?? [];
  const merged: { id: string; score: number }[] = [];
  for (const [error, pairs] of results as [Error | null, string[]][]) {
    if (error) throw error;
    for (let i = 0; i < pairs.length; i += 2) merged.push({ id: pairs[i]!, score: Number(pairs[i + 1]) });
  }
  merged.sort((a, b) => b.score - a.score);
  const ids = merged.slice(0, limit).map((m) => m.id);
  return (await hydrate(redis, keys, ids)).reverse();
}

interface UnionStream {
  value: string;
  cursor: number;
  buffer: { id: string; score: number }[];
  exhausted: boolean;
}

/** Refills every stream in `streams` whose buffer is currently empty and not yet exhausted, in a single
 * `pipeline()` round trip (a no-op call, no pipeline issued, when nothing needs refilling). Each fetch is
 * `ZREVRANGE idx cursor cursor+LINEAGE_SCAN_CHUNK_SIZE-1` -- never an unbounded `0 -1` -- and a chunk
 * shorter than `LINEAGE_SCAN_CHUNK_SIZE` marks that stream exhausted. */
async function refillEmptyStreams(
  redis: Redis,
  keys: RedisKeys,
  field: LineageIndexField,
  streams: UnionStream[],
): Promise<void> {
  const toFill = streams.filter((s) => !s.exhausted && s.buffer.length === 0);
  if (toFill.length === 0) return;
  const pipeline = redis.pipeline();
  for (const s of toFill) {
    pipeline.zrevrange(
      keys.lineage.index(field, s.value),
      s.cursor,
      s.cursor + LINEAGE_SCAN_CHUNK_SIZE - 1,
      "WITHSCORES",
    );
  }
  const results = (await pipeline.exec()) ?? [];
  toFill.forEach((s, i) => {
    const [error, pairs] = results[i] as [Error | null, string[]];
    if (error) throw error;
    const items: { id: string; score: number }[] = [];
    for (let j = 0; j < pairs.length; j += 2) items.push({ id: pairs[j]!, score: Number(pairs[j + 1]) });
    s.buffer = items;
    s.cursor += LINEAGE_SCAN_CHUNK_SIZE;
    if (items.length < LINEAGE_SCAN_CHUNK_SIZE) s.exhausted = true;
  });
}

/**
 * Non-exhaustive multi-value (`type`) union: a k-way merge across one bounded, chunked `ZREVRANGE` stream
 * per value (`refillEmptyStreams`), always popping the globally-next id (the largest-scored buffered
 * head across every stream) so ids come out in true newest-to-oldest order without ever reading an
 * index's whole range. A stream's buffer is refilled -- lazily, right before the next pop decision --
 * the moment it runs dry and isn't yet exhausted, because a not-yet-fetched item from that stream could
 * still outscore everything currently buffered elsewhere; only once every stream is either buffered or
 * exhausted can the next pop be trusted. Popped ids are hydrated and filtered in
 * `LINEAGE_SCAN_CHUNK_SIZE`-sized batches (not one at a time) purely as an I/O-batching optimization --
 * it does not affect the pop order above, which is what correctness depends on. Stops as soon as `limit`
 * matches are collected or every stream is exhausted.
 */
async function readUnionScan(
  redis: Redis,
  keys: RedisKeys,
  field: LineageIndexField,
  values: string[],
  filter: LineageFilter,
  limit: number,
): Promise<LineageEventRecord[]> {
  const streams: UnionStream[] = values.map((value) => ({ value, cursor: 0, buffer: [], exhausted: false }));
  const matches: LineageEventRecord[] = [];
  let pending: string[] = [];

  const flushPending = async (): Promise<boolean> => {
    if (pending.length === 0) return false;
    const ids = pending;
    pending = [];
    for (const event of await hydrate(redis, keys, ids)) {
      if (matchesLineageFilter(event, filter)) {
        matches.push(event);
        if (matches.length === limit) return true;
      }
    }
    return false;
  };

  for (;;) {
    await refillEmptyStreams(redis, keys, field, streams);
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < streams.length; i++) {
      const head = streams[i]!.buffer[0];
      if (head != null && head.score > bestScore) {
        bestScore = head.score;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break; // every stream is empty and exhausted: nothing left anywhere
    pending.push(streams[bestIndex]!.buffer.shift()!.id);
    if (pending.length >= LINEAGE_SCAN_CHUNK_SIZE && (await flushPending())) return matches.reverse();
  }
  await flushPending();
  return matches.reverse();
}

/** The multi-value (`type`) union path: `readUnionPushdown` when the filter is fully expressed by the
 * type indexes alone (no other predicate), `readUnionScan` otherwise. */
async function readUnion(
  redis: Redis,
  keys: RedisKeys,
  candidate: LineageIndexCandidate,
  filter: LineageFilter,
  limit: number,
  exhaustive: boolean,
): Promise<LineageEventRecord[]> {
  return exhaustive
    ? readUnionPushdown(redis, keys, candidate.field, candidate.values, limit)
    : readUnionScan(redis, keys, candidate.field, candidate.values, filter, limit);
}

/**
 * `StoragePort.listLineage`'s whole read path: chooses a candidate index (`chooseCandidateIndex`),
 * reads it via the cheapest strategy that still satisfies the filter (`readPushdown` when the index alone
 * is exhaustive, `scanForMatches` / `readUnion` otherwise, or a `by-seq` scan when there is no usable
 * index at all), and returns the result in append order. Every strategy above already stops at `limit`
 * matches on its own (the whole point of choosing it over a full scan-then-slice); `applyLineageLimit` is
 * still the single point that enforces the contract's own tail-window semantics (`DEFAULT_LINEAGE_LIMIT`
 * when `limit` is omitted, `limit <= 0` always empty), the same helper every other StoragePort uses.
 */
export async function readLineage(
  redis: Redis,
  keys: RedisKeys,
  filter: LineageFilter = {},
): Promise<LineageEventRecord[]> {
  const limit = filter.limit ?? DEFAULT_LINEAGE_LIMIT;
  if (limit <= 0) return [];

  const candidate = chooseCandidateIndex(filter);
  // `chooseCandidateIndex` already returns null only when `type`/`tenant`/every payload index field is
  // absent from `filter` -- so on this branch the only predicates a `by-seq` read could still need to
  // check client-side are `since`/`until`. When those are absent too (the empty filter the admin Lineage
  // tab and GET /analytics/summary both issue), `by-seq` alone already satisfies the whole filter, so the
  // `limit` pushdown (ZREVRANGE 0 limit-1) applies here exactly as it does for a single exhaustive index,
  // instead of the chunked scan hydrating up to LINEAGE_SCAN_CHUNK_SIZE bodies for a much smaller limit.
  const events = await (candidate == null
    ? filter.since == null && filter.until == null
      ? readPushdown(redis, keys, keys.lineage.bySeq, limit)
      : scanForMatches(redis, keys, keys.lineage.bySeq, filter, limit)
    : readCandidate(redis, keys, candidate, filter, limit));
  return applyLineageLimit(events, limit);
}

async function readCandidate(
  redis: Redis,
  keys: RedisKeys,
  candidate: LineageIndexCandidate,
  filter: LineageFilter,
  limit: number,
): Promise<LineageEventRecord[]> {
  const exhaustive = isIndexExhaustive(filter, candidate);
  if (candidate.values.length > 1) {
    return readUnion(redis, keys, candidate, filter, limit, exhaustive);
  }
  const indexKey = keys.lineage.index(candidate.field, candidate.values[0]!);
  return exhaustive
    ? readPushdown(redis, keys, indexKey, limit)
    : scanForMatches(redis, keys, indexKey, filter, limit);
}

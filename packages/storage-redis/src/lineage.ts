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
 * Reads every value's index for a multi-value candidate (only ever `type`, the one field
 * `chooseCandidateIndex` can return several values for) in a single `pipeline()` round trip -- rather
 * than one sequential `ZREVRANGE` per value -- merges the results by score (append seq) so the union
 * comes back in the same newest-to-oldest order a single index would produce, and dedupes by id
 * (defensive: an event's `type` is single-valued, so the same id should never appear under two different
 * `type` values in practice).
 */
async function unionIndexNewestFirst(
  redis: Redis,
  keys: RedisKeys,
  field: LineageIndexField,
  values: string[],
): Promise<string[]> {
  const pipeline = redis.pipeline();
  for (const value of values) pipeline.zrevrange(keys.lineage.index(field, value), 0, -1, "WITHSCORES");
  const results = (await pipeline.exec()) ?? [];
  const bestScore = new Map<string, number>();
  for (const [error, pairs] of results as [Error | null, string[]][]) {
    if (error) throw error;
    for (let i = 0; i < pairs.length; i += 2) {
      const id = pairs[i]!;
      const score = Number(pairs[i + 1]);
      const existing = bestScore.get(id);
      if (existing == null || score > existing) bestScore.set(id, score);
    }
  }
  return [...bestScore.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** The multi-value (`type`) union path: reads the merged, newest-first id list via
 * `unionIndexNewestFirst`, then either takes its newest `limit` ids directly (`exhaustive`) or scans it
 * in `LINEAGE_SCAN_CHUNK_SIZE` chunks applying `matchesLineageFilter`, exactly like `scanForMatches` but
 * over an already-known id list instead of issuing further `ZREVRANGE` calls. */
async function readUnion(
  redis: Redis,
  keys: RedisKeys,
  candidate: LineageIndexCandidate,
  filter: LineageFilter,
  limit: number,
  exhaustive: boolean,
): Promise<LineageEventRecord[]> {
  const idsNewestFirst = await unionIndexNewestFirst(redis, keys, candidate.field, candidate.values);
  if (exhaustive) {
    return (await hydrate(redis, keys, idsNewestFirst.slice(0, limit))).reverse();
  }
  const matches: LineageEventRecord[] = [];
  for (let i = 0; i < idsNewestFirst.length; i += LINEAGE_SCAN_CHUNK_SIZE) {
    const chunk = idsNewestFirst.slice(i, i + LINEAGE_SCAN_CHUNK_SIZE);
    for (const event of await hydrate(redis, keys, chunk)) {
      if (matchesLineageFilter(event, filter)) {
        matches.push(event);
        if (matches.length === limit) return matches.reverse();
      }
    }
  }
  return matches.reverse();
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
  const events = await (candidate == null
    ? scanForMatches(redis, keys, keys.lineage.bySeq, filter, limit)
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

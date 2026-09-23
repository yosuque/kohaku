import type {
  FixationRecord,
  LineageEventRecord,
  PromotionState,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { DEFAULT_KEY_PREFIX, type RedisKeys, redisKeys } from "./keys.js";
import { chooseCandidateIndex, indexValues, matchesFilter, tailLimit } from "./lineage.js";

export interface RedisStoragePortOptions {
  /** ioredis connection URL (`redis://…` / `rediss://…`). Mutually exclusive with `client`. */
  url?: string;
  /** An existing ioredis client to share. `close()` then leaves it connected (the owner disconnects it). */
  client?: Redis;
  /** Key prefix, default "kohaku". See keys.ts for the layout. */
  keyPrefix?: string;
}

export interface RedisStoragePort extends StoragePort {
  /** Disconnects the client this port created (a no-op for an injected client). */
  close(): Promise<void>;
}

/**
 * A Redis-backed StoragePort (reference adapter). The Spec cache is a plain key with an optional EX; lineage
 * is an append-only hash + sorted-set indexes; promotion state and fixations are one key per (tenant, id)
 * with sorted-set indexes for listing. All multi-key writes go through MULTI so a crash between commands
 * cannot leave an index pointing at a missing record. The cross-process concurrency contract of ports.ts
 * still applies: this port serializes nothing beyond single commands / MULTI blocks; the host keys its own
 * mutex per (tenant, key).
 */
export function createRedisStoragePort(options: RedisStoragePortOptions): RedisStoragePort {
  if (options.client != null && options.url != null) {
    throw new Error("createRedisStoragePort: pass either `url` or `client`, not both");
  }
  if (options.client == null && options.url == null) {
    throw new Error("createRedisStoragePort: one of `url` or `client` is required");
  }
  const owned = options.client == null;
  const redis = options.client ?? new Redis(options.url!, { lazyConnect: false });
  const keys: RedisKeys = redisKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX);

  return {
    async getSpecCache(key) {
      const raw = await redis.get(keys.spec(key));
      return raw == null ? null : (JSON.parse(raw) as UISpec);
    },
    async putSpecCache(key, spec, ttlSeconds) {
      const value = JSON.stringify(spec);
      if (ttlSeconds != null && ttlSeconds > 0)
        await redis.set(keys.spec(key), value, "EX", Math.ceil(ttlSeconds));
      else await redis.set(keys.spec(key), value);
    },
    async appendLineage(event) {
      const seq = await redis.incr(keys.lineage.seq);
      const multi = redis.multi();
      multi.hset(keys.lineage.events, event.id, JSON.stringify(event));
      multi.zadd(keys.lineage.bySeq, seq, event.id);
      for (const { field, value } of indexValues(event)) {
        multi.zadd(keys.lineage.index(field, value), seq, event.id);
      }
      await multi.exec();
    },
    async listLineage(filter = {}) {
      const candidate = chooseCandidateIndex(filter);
      let ids: string[];
      if (candidate == null) {
        ids = await redis.zrange(keys.lineage.bySeq, 0, -1);
      } else if (candidate.values.length === 1) {
        ids = await redis.zrange(keys.lineage.index(candidate.field, candidate.values[0]!), 0, -1);
      } else {
        // Union of several index sets, re-sorted by seq (WITHSCORES) so append order is kept.
        const scored = new Map<string, number>();
        for (const value of candidate.values) {
          const pairs = await redis.zrange(keys.lineage.index(candidate.field, value), 0, -1, "WITHSCORES");
          for (let i = 0; i < pairs.length; i += 2) scored.set(pairs[i]!, Number(pairs[i + 1]));
        }
        ids = [...scored.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
      }
      if (ids.length === 0) return [];
      const raws = await redis.hmget(keys.lineage.events, ...ids);
      const events: LineageEventRecord[] = [];
      for (const raw of raws) {
        if (raw == null) continue; // an index entry whose body is gone (should not happen under MULTI; skip defensively)
        const event = JSON.parse(raw) as LineageEventRecord;
        if (matchesFilter(event, filter)) events.push(event);
      }
      return tailLimit(events, filter.limit);
    },
    async getPromotionState(artifactId, tenant) {
      const raw = await redis.get(keys.promotion(tenant, artifactId));
      return raw == null ? null : (JSON.parse(raw) as PromotionState);
    },
    async putPromotionState(state) {
      await putIndexed(
        redis,
        keys.promotionSeq,
        keys.promotion(state.tenant, state.artifactId),
        state.tenant,
        keys.promotionIndex,
        state,
      );
    },
    async putPromotionStates(states) {
      if (states.length === 0) return;
      const seqs = await nextSeqs(redis, keys.promotionSeq, states.length);
      const multi = redis.multi();
      states.forEach((state, i) => {
        const key = keys.promotion(state.tenant, state.artifactId);
        multi.set(key, JSON.stringify(state));
        multi.zadd(keys.promotionIndex(undefined), "NX", seqs[i]!, key);
        if (state.tenant != null && state.tenant !== "")
          multi.zadd(keys.promotionIndex(state.tenant), "NX", seqs[i]!, key);
      });
      await multi.exec();
    },
    async listPromotionStates(tenant) {
      return listIndexed<PromotionState>(redis, keys.promotionIndex(tenant));
    },
    async getFixation(intentHash, tenant) {
      const raw = await redis.get(keys.fixation(tenant, intentHash));
      return raw == null ? null : (JSON.parse(raw) as FixationRecord);
    },
    async putFixation(record, options) {
      const key = keys.fixation(record.tenant, record.intentHash);
      if (options?.ifPresent === true) {
        // XX: only overwrite an existing key. The indexes already contain it, so nothing else to do.
        await redis.set(key, JSON.stringify(record), "XX");
        return;
      }
      await putIndexed(redis, keys.fixationSeq, key, record.tenant, keys.fixationIndex, record);
    },
    async listFixations(tenant) {
      return listIndexed<FixationRecord>(redis, keys.fixationIndex(tenant));
    },
    async deleteFixation(intentHash, tenant) {
      const key = keys.fixation(tenant, intentHash);
      const multi = redis.multi();
      multi.del(key);
      multi.zrem(keys.fixationIndex(undefined), key);
      if (tenant != null && tenant !== "") multi.zrem(keys.fixationIndex(tenant), key);
      await multi.exec();
    },
    async close() {
      if (owned) await redis.quit();
    },
  };
}

/** Reserves `count` consecutive sequence numbers (a single INCRBY). */
async function nextSeqs(redis: Redis, seqKey: string, count: number): Promise<number[]> {
  const last = await redis.incrby(seqKey, count);
  return Array.from({ length: count }, (_, i) => last - count + 1 + i);
}

/**
 * Writes one record and registers its key in the all-tenants index and (when tenant-scoped) the per-tenant
 * index. `ZADD NX` keeps the first-insertion position on overwrite, mirroring the file port's Map order.
 */
async function putIndexed(
  redis: Redis,
  seqKey: string,
  key: string,
  tenant: string | undefined,
  indexKey: (tenant: string | undefined) => string,
  value: unknown,
): Promise<void> {
  const seq = await redis.incr(seqKey);
  const multi = redis.multi();
  multi.set(key, JSON.stringify(value));
  multi.zadd(indexKey(undefined), "NX", seq, key);
  if (tenant != null && tenant !== "") multi.zadd(indexKey(tenant), "NX", seq, key);
  await multi.exec();
}

/** Reads every record an index points at, in index (first-insertion) order. */
async function listIndexed<T>(redis: Redis, indexKey: string): Promise<T[]> {
  const memberKeys = await redis.zrange(indexKey, 0, -1);
  if (memberKeys.length === 0) return [];
  const raws = await redis.mget(...memberKeys);
  const out: T[] = [];
  for (const raw of raws) if (raw != null) out.push(JSON.parse(raw) as T);
  return out;
}

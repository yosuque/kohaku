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
    async getPromotionState(_artifactId: string, _tenant?: string) {
      throw new Error("not implemented");
    },
    async putPromotionState(_state: PromotionState) {
      throw new Error("not implemented");
    },
    async putPromotionStates(_states: PromotionState[]) {
      throw new Error("not implemented");
    },
    async listPromotionStates(_tenant?: string) {
      throw new Error("not implemented");
    },
    async getFixation(_intentHash: string, _tenant?: string) {
      throw new Error("not implemented");
    },
    async putFixation(_record: FixationRecord, _options?: { ifPresent?: boolean }) {
      throw new Error("not implemented");
    },
    async listFixations(_tenant?: string) {
      throw new Error("not implemented");
    },
    async deleteFixation(_intentHash: string, _tenant?: string) {
      throw new Error("not implemented");
    },
    async close() {
      if (owned) await redis.quit();
    },
  };
}

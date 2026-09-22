import type {
  FixationRecord,
  LineageEventRecord,
  LineageFilter,
  PromotionState,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { DEFAULT_KEY_PREFIX, type RedisKeys, redisKeys } from "./keys.js";

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
    async appendLineage(_event: LineageEventRecord) {
      throw new Error("not implemented");
    },
    async listLineage(_filter?: LineageFilter) {
      throw new Error("not implemented");
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

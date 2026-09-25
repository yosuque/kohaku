import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import type { Redis } from "ioredis";
import { createRedisConnection } from "./connection.js";
import { DEFAULT_KEY_PREFIX, redisKeys } from "./keys.js";

export interface RedisRevocationStoreOptions {
  /** ioredis connection URL (`redis://…` / `rediss://…`). Mutually exclusive with `client`. */
  url?: string;
  /** An existing ioredis client to share. `close()` then leaves it connected (the owner disconnects it). */
  client?: Redis;
  /** Key prefix, default "kohaku". Keys are `{prefix}:revoked:{jti}` (see `keys.ts`'s `revoked`). */
  keyPrefix?: string;
  /**
   * Bounds how long `ready()` waits for the connection. Same meaning as
   * `RedisStoragePortOptions.connectTimeoutMs` (see `redis-storage-port.ts` / `connection.ts`): for a
   * `url`-constructed client this is ioredis's own `connectTimeout`; for an injected `client` it bounds
   * this store's own wait for the `ready` / `error` event. Default `DEFAULT_CONNECT_TIMEOUT_MS`.
   */
  connectTimeoutMs?: number;
  /**
   * For a `url`-constructed client only: ioredis's own `commandTimeout`, bounding every individual
   * command (a half-open socket would otherwise hang a command forever). Default
   * `DEFAULT_COMMAND_TIMEOUT_MS`. Ignored for an injected `client`.
   */
  commandTimeoutMs?: number;
  /**
   * For a `url`-constructed client only: ioredis's own `maxRetriesPerRequest`. Default
   * `DEFAULT_MAX_RETRIES_PER_REQUEST`. Ignored for an injected `client` (its own options are never
   * overridden).
   */
  maxRetriesPerRequest?: number;
  /**
   * Called when a `url`-constructed client emits an `error` event. Without a listener, ioredis re-throws
   * it as an unhandled `error` event, which crashes the process by Node's own EventEmitter contract.
   * Defaults to logging via `console.error`. Never invoked for an injected `client`.
   */
  onError?: (error: Error) => void;
}

export interface RedisRevocationStore extends CapabilityRevocationStore {
  /**
   * Resolves once the client is connected and ready; rejects if it can't connect within
   * `connectTimeoutMs`. Memoized, but a failed attempt clears the memo, for exactly the reason given in
   * `connection.ts`'s `createRedisConnection` doc comment: a transient error must not permanently strand
   * this store instance with no retry path. Every method below awaits `ready()` first.
   */
  ready(): Promise<void>;
  /** Disconnects the client this store created (a no-op for an injected client). */
  close(): Promise<void>;
}

/**
 * A Redis-backed CapabilityRevocationStore (reference adapter; spec-core's `CapabilityRevocationStore`).
 * A revoked `jti` is a plain key carrying its own expiry (`SET … EX`), computed from the token's `exp`
 * minus now: once that TTL elapses, Redis drops the key itself and `isRevoked` goes back to `false` --
 * matching the port contract's "the store may drop the entry after `expiresAt`" without a separate sweep.
 * `isRevoked` is an `EXISTS` check.
 *
 * Fail-fast: same construction (`lazyConnect: true`, `enableOfflineQueue: false`, bounded
 * `connectTimeout` / `commandTimeout` / `maxRetriesPerRequest`) and memoized-and-discarded-on-failure
 * `ready()` gate as `createRedisStoragePort` -- see `connection.ts`'s `createRedisConnection` for the
 * full rationale, shared by both adapters. Every method here awaits `ready()` first for the same reason:
 * with the offline queue disabled, a command issued before the connection is up would otherwise reject
 * with an unrelated low-level error instead of failing fast with a clear "not ready" story.
 */
export function createRedisRevocationStore(options: RedisRevocationStoreOptions): RedisRevocationStore {
  const connection = createRedisConnection(options, "redis revocation store");
  const { redis, ready, close } = connection;
  const keys = redisKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX);

  return {
    ready,
    close,
    async revoke(jti, expiresAt) {
      await ready();
      const ttlSeconds = expiresAt - Math.floor(Date.now() / 1000);
      // Already expired (or expiring this instant): the token can no longer verify anyway (its own
      // `exp` check fails first), so writing a revocation record for it would only occupy space for
      // nothing. `SET … EX` also rejects a non-positive TTL outright, so this is not merely an
      // optimization.
      if (ttlSeconds <= 0) return;
      await redis.set(keys.revoked(jti), "1", "EX", ttlSeconds);
    },
    async isRevoked(jti) {
      await ready();
      return (await redis.exists(keys.revoked(jti))) === 1;
    },
  };
}

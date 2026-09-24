import type { CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { connectOwned, waitUntilReady } from "./connection.js";
import { DEFAULT_KEY_PREFIX } from "./keys.js";

export interface RedisRevocationStoreOptions {
  /** ioredis connection URL (`redis://…` / `rediss://…`). Mutually exclusive with `client`. */
  url?: string;
  /** An existing ioredis client to share. `close()` then leaves it connected (the owner disconnects it). */
  client?: Redis;
  /** Key prefix, default "kohaku". Keys are `{prefix}:revoked:{jti}`. */
  keyPrefix?: string;
  /**
   * Bounds how long `ready()` waits for the connection. Same meaning as
   * `RedisStoragePortOptions.connectTimeoutMs` (see `redis-storage-port.ts`): for a `url`-constructed
   * client this is ioredis's own `connectTimeout`; for an injected `client` it bounds this store's own
   * wait for the `ready` / `error` event. Default 5000ms.
   */
  connectTimeoutMs?: number;
  /**
   * For a `url`-constructed client only: ioredis's own `maxRetriesPerRequest`. Default 3. Ignored for an
   * injected `client` (its own options are never overridden).
   */
  maxRetriesPerRequest?: number;
}

export interface RedisRevocationStore extends CapabilityRevocationStore {
  /**
   * Resolves once the client is connected and ready; rejects if it can't connect within
   * `connectTimeoutMs`. Memoized, but a failed attempt clears the memo, for exactly the reason given in
   * `RedisStoragePort.ready()`'s doc comment: a transient error must not permanently strand this store
   * instance with no retry path. Every method below awaits `ready()` first.
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
 * `connectTimeout`/`maxRetriesPerRequest`) and memoized-and-discarded-on-failure `ready()` gate as
 * `createRedisStoragePort` -- see `redis-storage-port.ts` for the full rationale. Every method here
 * awaits `ready()` first for the same reason: with the offline queue disabled, a command issued before
 * the connection is up would otherwise reject with an unrelated low-level error instead of failing fast
 * with a clear "not ready" story.
 */
export function createRedisRevocationStore(options: RedisRevocationStoreOptions): RedisRevocationStore {
  if (options.client != null && options.url != null) {
    throw new Error("createRedisRevocationStore: pass either `url` or `client`, not both");
  }
  if (options.client == null && options.url == null) {
    throw new Error("createRedisRevocationStore: one of `url` or `client` is required");
  }
  const owned = options.client == null;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  const redis =
    options.client ??
    new Redis(options.url!, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
      connectTimeout: connectTimeoutMs,
    });
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const key = (jti: string): string => `${prefix}:revoked:${jti}`;

  let readyPromise: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (readyPromise == null) {
      const attempt = owned ? connectOwned(redis) : waitUntilReady(redis, connectTimeoutMs);
      readyPromise = attempt.catch((error: unknown) => {
        // Don't memoize a failed connection attempt -- see the `RedisRevocationStore.ready()` doc
        // comment (mirrors `redis-storage-port.ts`'s `ready()`, fixed twice on this branch already).
        readyPromise = undefined;
        throw error instanceof Error
          ? new Error(`redis revocation store is not ready: ${error.message}`, { cause: error })
          : error;
      });
    }
    return readyPromise;
  };

  return {
    ready,
    async revoke(jti, expiresAt) {
      await ready();
      const ttlSeconds = expiresAt - Math.floor(Date.now() / 1000);
      // Already expired (or expiring this instant): the token can no longer verify anyway (its own
      // `exp` check fails first), so writing a revocation record for it would only occupy space for
      // nothing. `SET … EX` also rejects a non-positive TTL outright, so this is not merely an
      // optimization.
      if (ttlSeconds <= 0) return;
      await redis.set(key(jti), "1", "EX", ttlSeconds);
    },
    async isRevoked(jti) {
      await ready();
      return (await redis.exists(key(jti))) === 1;
    },
    async close() {
      if (!owned) return;
      try {
        await redis.quit();
      } catch {
        // Same fallback as `RedisStoragePort.close()`: `enableOfflineQueue: false` means `quit()`
        // rejects outright whenever the client isn't currently writable (never connected, or
        // mid-backoff after a failed `ready()` attempt). `disconnect()` works from any client status
        // and cancels ioredis's own pending reconnect timer.
        redis.disconnect();
      }
    },
  };
}

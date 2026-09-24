import type { FixationRecord, PromotionState, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { normalizeTenant } from "@kohaku-ui/spec-core";
import type { Redis } from "ioredis";
import { createRedisConnection } from "./connection.js";
import { DEFAULT_KEY_PREFIX, type RedisKeys, redisKeys } from "./keys.js";
import { indexValues, readLineage } from "./lineage.js";

export interface RedisStoragePortOptions {
  /** ioredis connection URL (`redis://…` / `rediss://…`). Mutually exclusive with `client`. */
  url?: string;
  /** An existing ioredis client to share. `close()` then leaves it connected (the owner disconnects it). */
  client?: Redis;
  /** Key prefix, default "kohaku". See keys.ts for the layout. */
  keyPrefix?: string;
  /**
   * Bounds how long `ready()` waits for the connection. For a `url`-constructed client this is passed to
   * ioredis as `connectTimeout` (bounding the initial connection attempt); for an injected `client` it
   * bounds this port's own wait for the `ready` / `error` event (the injected client's own options are
   * never overridden -- see `connection.ts`). Default `DEFAULT_CONNECT_TIMEOUT_MS`.
   */
  connectTimeoutMs?: number;
  /**
   * For a `url`-constructed client only: ioredis's own `commandTimeout`, bounding every individual
   * command. Without it, a command sent over a half-open socket (the connection looks alive but the peer
   * never responds) hangs forever instead of failing. Default `DEFAULT_COMMAND_TIMEOUT_MS`. Ignored for
   * an injected `client` (its own options are never overridden).
   */
  commandTimeoutMs?: number;
  /**
   * For a `url`-constructed client only: ioredis's own `maxRetriesPerRequest` (how many times a command
   * queued while disconnected is retried across reconnects before giving up). Default
   * `DEFAULT_MAX_RETRIES_PER_REQUEST`. Ignored for an injected `client` (its own options are never
   * overridden).
   */
  maxRetriesPerRequest?: number;
  /**
   * Called when a `url`-constructed client emits an `error` event (a connection drop, a command
   * timeout). Without a listener, ioredis re-throws it as an unhandled `error` event, which crashes the
   * process by Node's own EventEmitter contract. Defaults to logging via `console.error`. Never invoked
   * for an injected `client` (attach your own listener to it instead).
   */
  onError?: (error: Error) => void;
}

export interface RedisStoragePort extends StoragePort {
  /**
   * Resolves once the client is connected and ready to accept commands; rejects if it can't connect
   * within `connectTimeoutMs`. Memoized, but a failed attempt clears the memo -- mirrors
   * storage-postgres's `ready()`: a transient error (Redis briefly unreachable, a restart mid-deploy)
   * would otherwise permanently strand this port instance with no retry path, so the next `ready()` call
   * (from the next method call) retries from scratch rather than replaying a cached rejection forever.
   * See `connection.ts`'s `createRedisConnection` for the full mechanics (shared with the revocation
   * store).
   *
   * Every method on this port awaits `ready()` first: with the offline queue disabled (see
   * `createRedisStoragePort`'s doc comment), a command issued before the connection is up would otherwise
   * reject outright ("Stream isn't writeable...") instead of failing fast with a clear "not ready" story.
   */
  ready(): Promise<void>;
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
 *
 * Every tenant parameter is normalized with `@kohaku-ui/spec-core`'s `normalizeTenant` before it ever keys
 * or filters a record (via `keys.ts`, which applies it at the key-building layer): `""` and `undefined`
 * are always treated identically, on both writes and reads.
 *
 * Fail-fast: a `url`-constructed client is built with `lazyConnect: true`, `enableOfflineQueue: false`, a
 * bounded `connectTimeout`, and a bounded `commandTimeout` (see `connection.ts`'s `createRedisConnection`).
 * Without those, a command issued while Redis is unreachable would otherwise queue silently (ioredis's
 * default offline queue) and hang the caller until some timeout elsewhere fires, and a command sent over a
 * half-open socket would hang rather than time out -- this stack has no request-level timeout of its own.
 * `ready()` (see the `RedisStoragePort` interface, awaited by every method below) is what turns
 * "unreachable" into a bounded rejection instead. This is not applied to an injected `client`: overriding
 * options the caller chose for their own shared client is not this port's call -- see the README for why
 * `enableOfflineQueue: false` is recommended there too.
 */
export function createRedisStoragePort(options: RedisStoragePortOptions): RedisStoragePort {
  const connection = createRedisConnection(options, "redis storage port");
  const { redis, ready, close } = connection;
  const keys: RedisKeys = redisKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX);

  return {
    ready,
    close,
    async getSpecCache(key) {
      await ready();
      const raw = await redis.get(keys.spec(key));
      return raw == null ? null : (JSON.parse(raw) as UISpec);
    },
    async putSpecCache(key, spec, ttlSeconds) {
      await ready();
      const value = JSON.stringify(spec);
      if (ttlSeconds != null && ttlSeconds > 0)
        await redis.set(keys.spec(key), value, "EX", Math.ceil(ttlSeconds));
      else await redis.set(keys.spec(key), value);
    },
    async appendLineage(event) {
      await ready();
      // Idempotent re-append of an already-recorded id: HSETNX only sets the body when the field is
      // absent (returns 0 when it already exists), so a duplicate append is a no-op that neither
      // consumes a fresh position in `by-seq` nor moves the event -- mirrors storage-postgres's
      // `ON CONFLICT (id) DO NOTHING`.
      const created = await redis.hsetnx(keys.lineage.events, event.id, JSON.stringify(event));
      if (created === 0) return;
      const seq = await redis.incr(keys.lineage.seq);
      const multi = redis.multi();
      // NX on every index write too: belt-and-suspenders against a race between two concurrent appends
      // of the same id (the HSETNX above already prevents the common case, but NX means a repeated ZADD
      // can never move a member that another writer already indexed).
      multi.zadd(keys.lineage.bySeq, "NX", seq, event.id);
      for (const { field, value } of indexValues(event)) {
        multi.zadd(keys.lineage.index(field, value), "NX", seq, event.id);
      }
      await multi.exec();
    },
    async listLineage(filter = {}) {
      await ready();
      return readLineage(redis, keys, filter);
    },
    async getPromotionState(artifactId, tenant) {
      await ready();
      const raw = await redis.get(keys.promotion(tenant, artifactId));
      return raw == null ? null : (JSON.parse(raw) as PromotionState);
    },
    async putPromotionState(state) {
      await ready();
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
      await ready();
      const seqs = await nextSeqs(redis, keys.promotionSeq, states.length);
      const multi = redis.multi();
      states.forEach((state, i) => {
        const key = keys.promotion(state.tenant, state.artifactId);
        multi.set(key, JSON.stringify(state));
        multi.zadd(keys.promotionIndex(undefined), "NX", seqs[i]!, key);
        if (normalizeTenant(state.tenant) != null)
          multi.zadd(keys.promotionIndex(state.tenant), "NX", seqs[i]!, key);
      });
      await multi.exec();
    },
    async listPromotionStates(tenant) {
      await ready();
      return listIndexed<PromotionState>(redis, keys.promotionIndex(tenant));
    },
    async getFixation(intentHash, tenant) {
      await ready();
      const raw = await redis.get(keys.fixation(tenant, intentHash));
      return raw == null ? null : (JSON.parse(raw) as FixationRecord);
    },
    async putFixation(record, options) {
      await ready();
      const key = keys.fixation(record.tenant, record.intentHash);
      if (options?.ifPresent === true) {
        // XX: only overwrite an existing key. The indexes already contain it, so nothing else to do.
        await redis.set(key, JSON.stringify(record), "XX");
        return;
      }
      await putIndexed(redis, keys.fixationSeq, key, record.tenant, keys.fixationIndex, record);
    },
    async listFixations(tenant) {
      await ready();
      return listIndexed<FixationRecord>(redis, keys.fixationIndex(tenant));
    },
    async deleteFixation(intentHash, tenant) {
      await ready();
      const key = keys.fixation(tenant, intentHash);
      const multi = redis.multi();
      multi.del(key);
      multi.zrem(keys.fixationIndex(undefined), key);
      if (normalizeTenant(tenant) != null) multi.zrem(keys.fixationIndex(tenant), key);
      await multi.exec();
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
  if (normalizeTenant(tenant) != null) multi.zadd(indexKey(tenant), "NX", seq, key);
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

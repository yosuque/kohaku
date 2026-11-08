import type { FixationRecord, PromotionState, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { createKeyedMutex, normalizeTenant, StorageConflictError } from "@kohaku-ui/spec-core";
import type { ChainableCommander, Redis } from "ioredis";
import { createRedisConnection } from "./connection.js";
import { DEFAULT_KEY_PREFIX, type RedisKeys, redisKeys } from "./keys.js";
import { indexValues, readLineage, readLineagePage } from "./lineage.js";

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
  /**
   * Disconnects the connections this port created: the `url`-constructed client, and (for either kind of
   * client) the dedicated connection the compare-and-set writes lazily open. A no-op for an injected client
   * that no compare-and-set write has touched (its owner disconnects it).
   */
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
  const { redis, ready } = connection;
  const keys: RedisKeys = redisKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX);
  const cas = createCompareAndSet(redis, ready, options);

  return {
    supportsCompareAndSet: true,
    ready,
    async close() {
      await cas.close();
      await connection.close();
    },
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
      // Idempotent, and atomic, re-append of an already-recorded id: `HSETNX` (the body) and `ZADD NX`
      // (`by-seq` and every index) all go in the SAME `MULTI`/`EXEC` block, so a crash between them is
      // impossible -- either every one of these commands applies, or none does. `NX` on every one of
      // them means a duplicate id's write is a no-op across the board (each command finds its target
      // already present and does nothing), so the same block serves both the fresh-append and the
      // duplicate-append case without a separate check-then-act round trip (which -- see the earlier,
      // now-superseded HSETNX-then-conditionally-index version -- could leave the body recorded but
      // never indexed if the process crashed in between).
      //
      // The `seq` value is reserved up front, unconditionally, because whether this append is a
      // duplicate is only known once the MULTI is queued: a duplicate append therefore consumes (and
      // wastes) one seq value. `seq` is only ever used as a sort key (append order), never as a
      // contiguous counter, so a gap here is harmless -- see the README.
      //
      // Known, accepted limitation: `indexValues` is computed from THIS call's `event`, not from
      // whatever body ends up stored. A duplicate append with the SAME payload (the only realistic
      // duplicate: a retried call after an ambiguous prior outcome) is a true no-op everywhere, since
      // every `ZADD NX` targets the same (index, member, score) it already holds. A duplicate id
      // re-appended with a genuinely DIFFERENT payload -- not a real retry, but a caller violating the
      // "id determines content" invariant the id space assumes -- can still add a spurious index entry
      // for the new payload's field values (pointing at a body whose actual fields don't match it),
      // even though `HSETNX` correctly leaves the stored body itself untouched. Closing that would need
      // either a Lua script (ruled out) or a read-before-write, which reintroduces the very
      // crash-between-steps window this MULTI exists to remove.
      const seq = await redis.incr(keys.lineage.seq);
      const multi = redis.multi();
      multi.hsetnx(keys.lineage.events, event.id, JSON.stringify(event));
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
    async pageLineage(req) {
      await ready();
      return readLineagePage(redis, keys, req);
    },
    async getPromotionState(artifactId, tenant) {
      await ready();
      const raw = await redis.get(keys.promotion(tenant, artifactId));
      return raw == null ? null : (JSON.parse(raw) as PromotionState);
    },
    async putPromotionState(state, putOptions) {
      await ready();
      const expected = putOptions?.expectedRevision;
      if (expected !== undefined) {
        const key = keys.promotion(state.tenant, state.artifactId);
        await cas.write(
          "promotion",
          state.artifactId,
          key,
          (current, multi, seq) => {
            checkRevision("promotion", state.artifactId, current, expected);
            queueIndexed(multi, seq, key, state.tenant, keys.promotionIndex, state);
          },
          keys.promotionSeq,
        );
        return;
      }
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
      await putIndexedMany(
        redis,
        keys.promotionSeq,
        states.map((state) => ({
          key: keys.promotion(state.tenant, state.artifactId),
          tenant: state.tenant,
          value: state,
        })),
        keys.promotionIndex,
      );
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
      const expected = options?.expectedRevision;
      if (expected !== undefined) {
        // ifPresent + null is contradictory ("must exist" and "must not exist"): always a conflict.
        if (options?.ifPresent === true && expected === null) {
          throw new StorageConflictError("fixation", record.intentHash);
        }
        await cas.write(
          "fixation",
          record.intentHash,
          key,
          (current, multi, seq) => {
            // ifPresent first: an absent record is a silent no-op even when a string was expected.
            if (options?.ifPresent === true && current == null) return "skip";
            checkRevision("fixation", record.intentHash, current, expected);
            queueIndexed(multi, seq, key, record.tenant, keys.fixationIndex, record);
            return undefined;
          },
          keys.fixationSeq,
        );
        return;
      }
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
    async deleteFixation(intentHash, tenant, deleteOptions) {
      await ready();
      const key = keys.fixation(tenant, intentHash);
      if (deleteOptions?.expectedRevision !== undefined) {
        const expected = deleteOptions.expectedRevision;
        await cas.write("fixation", intentHash, key, (current, multi) => {
          checkRevision("fixation", intentHash, current, expected);
          multi.del(key);
          multi.zrem(keys.fixationIndex(undefined), key);
          if (normalizeTenant(tenant) != null) multi.zrem(keys.fixationIndex(tenant), key);
        });
        return;
      }
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
  queueIndexed(multi, seq, key, tenant, indexKey, value);
  await multi.exec();
}

/**
 * `putIndexed` for a batch: reserves one consecutive block of sequence numbers (a single INCRBY), then
 * writes every record in one MULTI. The caller returns early on an empty batch.
 */
async function putIndexedMany(
  redis: Redis,
  seqKey: string,
  entries: readonly { key: string; tenant: string | undefined; value: unknown }[],
  indexKey: (tenant: string | undefined) => string,
): Promise<void> {
  const seqs = await nextSeqs(redis, seqKey, entries.length);
  const multi = redis.multi();
  entries.forEach((entry, i) => {
    queueIndexed(multi, seqs[i]!, entry.key, entry.tenant, indexKey, entry.value);
  });
  await multi.exec();
}

/** Queues one record's SET plus its all-tenants / per-tenant index entries on `multi`. */
function queueIndexed(
  multi: ChainableCommander,
  seq: number,
  key: string,
  tenant: string | undefined,
  indexKey: (tenant: string | undefined) => string,
  value: unknown,
): void {
  multi.set(key, JSON.stringify(value));
  multi.zadd(indexKey(undefined), "NX", seq, key);
  if (normalizeTenant(tenant) != null) multi.zadd(indexKey(tenant), "NX", seq, key);
}

/** Reads every record an index points at, in index (first-insertion) order. */
async function listIndexed<T>(redis: Redis, indexKey: string): Promise<T[]> {
  const memberKeys = await redis.zrange(indexKey, 0, "-1");
  if (memberKeys.length === 0) return [];
  const raws = await redis.mget(...memberKeys);
  const out: T[] = [];
  for (const raw of raws) if (raw != null) out.push(JSON.parse(raw) as T);
  return out;
}

/** The record `revision` out of a stored JSON body (`undefined` when the record has none). */
function revisionOf(raw: string): string | undefined {
  const revision = (JSON.parse(raw) as { revision?: unknown }).revision;
  return typeof revision === "string" ? revision : undefined;
}

/**
 * The compare-and-set check against the raw stored body (`null` = absent), the same tri-state as
 * `StoragePort`'s `expectedRevision`: `null` = must be absent; a string = must be present with exactly that
 * `revision` (a record with no revision never matches).
 */
function checkRevision(
  kind: "promotion" | "fixation",
  id: string,
  current: string | null,
  expected: string | null,
): void {
  if (expected === null) {
    if (current != null) throw new StorageConflictError(kind, id);
    return;
  }
  if (current == null || revisionOf(current) !== expected) throw new StorageConflictError(kind, id);
}

interface CompareAndSet {
  /**
   * One optimistic transaction on `key`: `WATCH key`, `GET key`, run `build` against the current body (it
   * queues the writes on the MULTI and throws `StorageConflictError` to abort, or returns `"skip"` to
   * write nothing), then `EXEC`. A null EXEC reply means another client touched `key` between the `WATCH`
   * and the `EXEC`, which is a conflict. `seqKey`, when given, reserves one sequence number for `build` (the
   * index insertion order); it is wasted on a conflict, like every other sequence reservation here.
   */
  write(
    kind: "promotion" | "fixation",
    id: string,
    key: string,
    build: (current: string | null, multi: ChainableCommander, seq: number) => "skip" | undefined,
    seqKey?: string,
  ): Promise<void>;
  close(): Promise<void>;
}

/**
 * The WATCH / MULTI / EXEC machinery behind the optional compare-and-set writes (Lua is deliberately not
 * used). `WATCH` state belongs to a connection, and an `EXEC` from any other `MULTI` on the same connection
 * would clear it, so these transactions run on their own lazily opened connection (`redis.duplicate()`),
 * never on the shared command connection that `appendLineage` and the plain writes pipeline through. Within
 * the process the transactions on that one connection are also serialized by a mutex (two interleaved
 * `WATCH`es on a single connection would otherwise share, and one `EXEC` would clear, the other's watch);
 * across processes the `WATCH` is what detects the race.
 * `close()` ends that connection; a `write()` racing shutdown could open a fresh one that is never closed, which only
 * matters while the process is exiting.
 */
function createCompareAndSet(
  redis: Redis,
  ready: () => Promise<void>,
  options: RedisStoragePortOptions,
): CompareAndSet {
  const lock = createKeyedMutex();
  let dedicated: Promise<Redis> | undefined;

  function dedicatedClient(): Promise<Redis> {
    if (dedicated == null) {
      const attempt = (async () => {
        await ready();
        const dup = redis.duplicate({ lazyConnect: true });
        dup.on("error", (error: Error) => {
          if (options.onError != null) options.onError(error);
          else
            console.error(
              "[@kohaku-ui/storage-redis] redis storage port: compare-and-set connection error:",
              error,
            );
        });
        try {
          if (dup.status !== "ready") await dup.connect();
        } catch (error) {
          dup.disconnect();
          throw error;
        }
        return dup;
      })();
      // Do not memoize a failed attempt (same policy as ready()).
      dedicated = attempt.catch((error: unknown) => {
        dedicated = undefined;
        throw error;
      });
    }
    return dedicated;
  }

  return {
    write(kind, id, key, build, seqKey) {
      return lock("cas", async () => {
        const client = await dedicatedClient();
        try {
          await client.watch(key);
          const current = await client.get(key);
          const seq = seqKey != null ? await client.incr(seqKey) : 0;
          const multi = client.multi();
          if (build(current, multi, seq) === "skip") return;
          // A null reply = the watched key changed under us: nothing was applied.
          const replies = await multi.exec();
          if (replies == null) throw new StorageConflictError(kind, id);
        } finally {
          // Drop the watch on every exit path (a conflict thrown before EXEC leaves it armed). Best effort:
          // if the connection itself is broken the next transaction's WATCH will fail loudly instead.
          await client.unwatch().catch(() => {});
        }
      });
    },
    async close() {
      const pending = dedicated;
      dedicated = undefined;
      if (pending == null) return;
      let client: Redis;
      try {
        client = await pending;
      } catch {
        return;
      }
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}

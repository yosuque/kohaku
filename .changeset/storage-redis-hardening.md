---
"@kohaku-ui/storage-redis": minor
---

Hardens the Redis adapter for production use. A new shared `connection.ts` (`createRedisConnection`, used
internally by both `createRedisStoragePort` and `createRedisRevocationStore`) owns the client lifecycle: a
`url`-constructed client now gets an `error` listener (default `console.error`, overridable via the new
`onError` option — an unhandled `error` event on an ioredis client otherwise crashes the process), and a
new `commandTimeoutMs` option (default 5000, ioredis's `commandTimeout`) bounds a hung command over a
half-open socket instead of letting it wait forever; `connectTimeoutMs` (default 5000) and
`maxRetriesPerRequest` (default 3) are unchanged. An injected `client` is unaffected (no listener attached,
never disconnected by `close()`).

`listLineage` no longer reads a whole candidate index (or the whole event log) before applying `limit`:
`chooseCandidateIndex` now prefers a single-value `type` filter over `tenant`, a filter fully expressed by
its chosen index reads only the newest `limit` ids (`ZREVRANGE idx 0 limit-1`), and every other case scans
the index from the newest side in bounded chunks (`LINEAGE_SCAN_CHUNK_SIZE`, 500), stopping as soon as
`limit` matches are found. A multi-value `type` filter unions its indexes in a single `pipeline()` round
trip instead of one sequential `ZREVRANGE` per value. `appendLineage` is now idempotent (`HSETNX` on the
events hash, `ZADD NX` on every index write): re-appending an already-recorded id is a no-op that neither
moves the event nor consumes its own index entries a second time.

Every tenant parameter across the whole port is normalized with `@kohaku-ui/spec-core`'s `normalizeTenant`
(applied once, in `keys.ts`): an empty-string tenant now behaves exactly like an omitted one everywhere,
including a `listLineage` tenant filter. The capability revocation key (`{prefix}:revoked:{jti}`) is now
defined in `keys.ts` alongside every other key this package writes, instead of being built ad hoc in
`revocation.ts`.

**Known limitation, unchanged**: Redis Cluster is not supported (keys are not hash-tagged; `MULTI` spans
several keys) — standalone / Sentinel only. See the README's new "Production" section for this, the
retention caveat (the lineage log has no cap or rotation), and the `rediss://` / ACL recommendation.

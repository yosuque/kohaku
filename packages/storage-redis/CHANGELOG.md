# @kohaku-ui/storage-redis

## 0.3.0

### Minor Changes

- [#28](https://github.com/yosuque/kohaku/pull/28) [`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5) Thanks [@yosuque](https://github.com/yosuque)! - Capability tokens can now be revoked before they expire. `@kohaku-ui/spec-core` adds the
  `CapabilityRevocationStore` port type (`ports.ts`, alongside `AuthzPort`, which itself is unchanged).
  `@kohaku-ui/authz-hmac`'s tokens now carry a `jti`, `createHmacAuthzPort`'s `HmacAuthzOptions` accepts a
  `revocations` store, and the returned `HmacAuthzPort` exposes `revokeCapability(token)` (signature
  verified first, so a caller cannot revoke a `jti` it merely guessed) alongside the reference
  `createMemoryRevocationStore`. A token minted before this change carries no `jti` and verifies as
  before; it simply cannot be revoked and is left to expire on its own, so a rolling deploy does not break
  an older instance's already-issued tokens. `@kohaku-ui/authz-jwt`'s `createJwtAuthzPort` passes
  `revocations` through to the underlying `@kohaku-ui/authz-hmac` port and exposes the same
  `revokeCapability(token)`, delegating entirely; the JWT identity path is unaffected.
  
  `@kohaku-ui/storage-redis` adds `createRedisRevocationStore({ url | client, keyPrefix, connectTimeoutMs,
  maxRetriesPerRequest })`: a revoked `jti` is a plain key carrying its own `SET … EX` expiry derived from
  the token's `exp`, so Redis drops it once the token would have expired anyway (`revoke()` is a no-op when
  that remaining lifetime is already zero or negative); `isRevoked` is an `EXISTS` check. Same fail-fast
  construction and memoized-and-discarded-on-failure `ready()` gate as `createRedisStoragePort`, awaited by
  every method. `@kohaku-ui/storage-postgres` adds `createPostgresRevocationStore({ connectionString | pool,
  schema, migrate })` and a fifth table, `kohaku_capability_revocation` (`jti` primary key, `expires_at`),
  in the shared idempotent `postgresSchemaSql`; `revoke()` upserts, `isRevoked` filters by `expires_at >
  now()`, and `sweepExpiredRevocations()` deletes expired rows for a cron, the same treatment as the
  existing `sweepExpiredSpecCache()`. Both stores are exercised against a real backend via
  `describeRevocationStoreContract` (`@kohaku-ui/port-contracts`), skipping without Docker.

- [#28](https://github.com/yosuque/kohaku/pull/28) [`50cbb8a`](https://github.com/yosuque/kohaku/commit/50cbb8adec9e01fc7d906ea53528e4cf598e52ea) Thanks [@yosuque](https://github.com/yosuque)! - Production adapters: `@kohaku-ui/storage-redis` and `@kohaku-ui/storage-postgres` implement the whole `StoragePort` (Spec cache, lineage, promotion state, fixation, tenant scoping) so several host instances share one Spec cache and serve the same Intent as `cache: "hit"`; `@kohaku-ui/authz-jwt` resolves principal / roles / tenant from JWT / OIDC claims (shared secret or JWKS) and delegates capability tokens to `@kohaku-ui/authz-hmac`. All three are reference adapters over the unchanged `ports.ts` contract; the sample host selects them via `KOHAKU_STORAGE` / `KOHAKU_AUTHZ`.

- [#28](https://github.com/yosuque/kohaku/pull/28) [`12c862c`](https://github.com/yosuque/kohaku/commit/12c862ca5da46e5036192e4fde4cff796700e57a) Thanks [@yosuque](https://github.com/yosuque)! - `createRedisStoragePort` now builds a `url`-constructed client with `lazyConnect: true` and `enableOfflineQueue: false` (new `connectTimeoutMs` / `maxRetriesPerRequest` options), and adds a memoized `ready(): Promise<void>` that every method awaits first. Without this, a command issued while Redis is unreachable used to queue silently and hang the caller indefinitely; now it fails fast with a bounded rejection instead. An injected `client`'s options are never overridden — `ready()` resolves immediately when it is already `"ready"`, otherwise it waits for that client's own `ready` / `error` event bounded by `connectTimeoutMs`.

- [#32](https://github.com/yosuque/kohaku/pull/32) [`5f968d1`](https://github.com/yosuque/kohaku/commit/5f968d1ea478071cd90e92b21d6980e42559d98e) Thanks [@yosuque](https://github.com/yosuque)! - Hardens the Redis adapter for production use. A new shared `connection.ts` (`createRedisConnection`, used
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

- [#32](https://github.com/yosuque/kohaku/pull/32) [`1a66bf6`](https://github.com/yosuque/kohaku/commit/1a66bf68bc5d93bcd28e8749d3b9069708106351) Thanks [@yosuque](https://github.com/yosuque)! - Exports `createRedisConnection` (+ `CreateRedisConnectionOptions` / `RedisConnectionHandle`) from the package root. A caller that needs `createRedisStoragePort` and `createRedisRevocationStore` to share a single ioredis client (rather than each opening its own) can now build the client once with `createRedisConnection` and inject it into both via their existing `client` option, instead of reaching into the package's internal `./connection.js`.

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0

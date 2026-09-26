# @kohaku-ui/storage-postgres

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

- [#32](https://github.com/yosuque/kohaku/pull/32) [`68ddd14`](https://github.com/yosuque/kohaku/commit/68ddd14c992cb0f8ceac2294157ae3e0a275bd6a) Thanks [@yosuque](https://github.com/yosuque)! - Hardens the PostgreSQL adapter for production use. A new shared `connection.ts` (`createPostgresPool`,
  used internally by both `createPostgresStoragePort` and `createPostgresRevocationStore`) owns the pool
  lifecycle: an owned pool now gets an `error` listener (default `console.error`, overridable via the new
  `onError` option — an unhandled `error` on a `pg.Pool` otherwise crashes the process), and two new options,
  `connectTimeoutMs` (default 5000) and `statementTimeoutMs` (default 10000, enforced server-side via `pg`'s
  `statement_timeout`), bound a hung connection attempt or a runaway query instead of letting either hold a
  pool connection forever; `maxConnections` maps to `pg.Pool`'s own `max`. An injected `pool` is unaffected
  (no listener attached, never ended by `close()`).
  
  `ready()`'s migration now runs inside one transaction guarded by a Postgres advisory lock keyed by the
  schema name, so two instances migrating the same fresh schema concurrently serialize on the DDL instead
  of racing it (with a one-time retry on the rare SQLSTATE 23505/42P07 race that can still surface under
  concurrent first-run migration). A new `kohaku_schema_meta` table records `POSTGRES_SCHEMA_VERSION`; a
  deployed schema on an unexpected version now fails `ready()` fast, naming both the expected and found
  version, instead of silently drifting.
  
  Schema changes: `kohaku_lineage.tenant` now uses `''` for "no tenant" (matching the other three tables)
  instead of SQL NULL, and every tenant parameter across the whole port is normalized with
  `@kohaku-ui/spec-core`'s `normalizeTenant` (an empty-string tenant now behaves exactly like an omitted one
  everywhere, including `listPromotionStates("")` / `listFixations("")` / a `listLineage` tenant filter).
  `kohaku_lineage.id` is now `UNIQUE` and `appendLineage` is `ON CONFLICT (id) DO NOTHING` (idempotent
  re-append of an already-recorded event, one row at its original position). `kohaku_lineage.ts` is now
  `COLLATE "C"` (locale-independent `since`/`until` comparisons). New indexes: a partial index on
  `kohaku_spec_cache.expires_at`, and a `(seq)` index each on `kohaku_promotion_state` /
  `kohaku_fixation` for their all-tenant `ORDER BY seq` scan. `putPromotionStates` is now a single batched
  `INSERT ... SELECT FROM unnest(...)` statement (deduped last-write-wins) instead of one round trip per
  state.
  
  **Note for consumers**: if you have an existing deployment predating this version, read this package's
  README section "Migrating from a pre-release schema" before upgrading — it covers the `kohaku_lineage.id`
  uniqueness constraint and the `kohaku_lineage.tenant` NULL→`''` backfill this version's schema assumes.

- [#32](https://github.com/yosuque/kohaku/pull/32) [`1a66bf6`](https://github.com/yosuque/kohaku/commit/1a66bf68bc5d93bcd28e8749d3b9069708106351) Thanks [@yosuque](https://github.com/yosuque)! - Exports `createPostgresPool` (+ `CreatePostgresPoolOptions` / `PostgresPoolHandle`) from the package root. A caller that needs `createPostgresStoragePort` and `createPostgresRevocationStore` to share a single `pg.Pool` (rather than each opening its own) can now build the pool once with `createPostgresPool` and inject it into both via their existing `pool` option, instead of reaching into the package's internal `./connection.js`.

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0

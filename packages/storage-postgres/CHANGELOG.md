# @kohaku-ui/storage-postgres

## 0.4.1

### Patch Changes

- [#66](https://github.com/yosuque/kohaku/pull/66) [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b) Thanks [@yosuque](https://github.com/yosuque)! - `pageLineage` now floors a fractional `pageSize` to an integer before clamping it. spec-core exports `clampLineagePageSize()`, which the array-backed pager and the Redis and Postgres adapters share: a request for `2.5` previously became `LIMIT 3.5` (a Postgres error) and made the page-size bound ineffective for the memory and Redis pagers.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`a8b9590`](https://github.com/yosuque/kohaku/commit/a8b95905244795f8591cfd7f78ff89df6e0d4065) Thanks [@yosuque](https://github.com/yosuque)! - `ready()` now builds the `kohaku_lineage` `(correlation_id, seq)` index after the migration transaction commits, with `CREATE INDEX CONCURRENTLY` on a connection that has no statement timeout, instead of a plain `CREATE INDEX` inside the transaction. On a large lineage table the old build outlived the pool's default 10 s `statement_timeout`, rolled back, and made every StoragePort call fail on every retry while blocking inserts. The index is found through `pg_index.indisvalid` (an INVALID leftover is dropped and rebuilt; a long schema name no longer hides it), and a failed `ready()` retries with a 1 s to 60 s backoff instead of immediately.
  
  With `migrate: false`, `createPostgresStoragePort` now checks that `kohaku_lineage.correlation_id` exists and fails fast, naming the `ALTER TABLE`, instead of failing every lineage INSERT with 42703 and losing audit events silently. A deployment that runs `migrate: false` must apply the 0.4.x DDL before deploying (see the README's "Upgrading to 0.4.x"). `postgresSchemaSql` adds the column through a guarded `DO` block that takes no ACCESS EXCLUSIVE lock when the column is already there. Design.md decision 53 describes the behavior.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`ae99ee6`](https://github.com/yosuque/kohaku/commit/ae99ee6a3c392cfabe97ee4f00ac94d55508cf51) Thanks [@yosuque](https://github.com/yosuque)! - `ready()` no longer takes an ACCESS EXCLUSIVE lock on `kohaku_lineage` on every start: the `correlation_id` column and its index are added only when the catalog says they are missing, and the migration transaction runs with a 5 second `lock_timeout` so a start fails fast instead of queueing behind live traffic. The README gains an "Upgrading to 0.4.x" note with the `CREATE INDEX CONCURRENTLY` statement for large tables.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`1973b96`](https://github.com/yosuque/kohaku/commit/1973b96cfc39f589d01aeb50e638c91e89ab3120) Thanks [@yosuque](https://github.com/yosuque)! - `appendLineage` no longer fails for an oversized `correlationId`. A value longer than 256 characters is stored in the indexed `correlation_id` column as `sha256:<hex>` (a btree entry cannot hold a multi-kilobyte key), the `correlationId` filter applies the same transform so lookups by the full id still match, and the event's stored record keeps the original. The storage contract now checks a 4 KB `correlationId` against every adapter.
- Updated dependencies [[`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc)]:
  - @kohaku-ui/spec-core@0.4.1

## 0.4.0

### Minor Changes

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Add `LineageFilter.correlationId` (payload equality) and forward (append-order) paging over the lineage
  log, exposed as the optional `StoragePort.pageLineage` method (implemented by all four reference storage
  adapters), `GET /lineage?order=asc&cursor=&pageSize=` on the REST profile, and `KohakuClient.lineagePages()`
  on the client SDK. Both additions are backward compatible: a request that omits the new query parameters,
  and a `StoragePort` that does not implement `pageLineage`, behave exactly as before.

### Patch Changes

- Updated dependencies [[`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/spec-core@0.4.0

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

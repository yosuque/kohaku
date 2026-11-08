# @kohaku-ui/storage-postgres

## 0.6.0

### Minor Changes

- [#129](https://github.com/yosuque/kohaku/pull/129) [`f43a74c`](https://github.com/yosuque/kohaku/commit/f43a74cd7d2ccd365a2a4f452a420cbceeb6a96c) Thanks [@yosuque](https://github.com/yosuque)! - Python port (`kohaku-ui` on PyPI): new `kohaku.storage.postgres` subpackage (extra `postgres`, psycopg 3 and its connection pool), the port of this package, data-compatible with it so a TypeScript host and a Python host can serve one database. `create_postgres_storage_port(connection_string=… | pool=…, schema="public", migrate=True)` is a full `StoragePort` on the same tables, indexes and `POSTGRES_SCHEMA_VERSION` as the TypeScript adapter, migrated under the same advisory lock (`kohaku:schema:{schema}`) with the same retry backoff, concurrent index build and `migrate=False` read-only check, so both languages can start against one database at once; every JSON payload column stays `text`. The optional compare-and-set (`supports_compare_and_set`, `expected_revision`, `StorageConflictError`) is one conditional statement whose row count decides (`(payload::jsonb ->> 'revision')` predicate, `INSERT … ON CONFLICT DO NOTHING`), with no DDL change. `create_postgres_revocation_store` is the Postgres `CapabilityRevocationStore`. The generated DDL (seven schema names), the correlation-id digest and the stored JSON text are pinned byte for byte against the TypeScript adapter by the cross-language golden (`storageLayout`), and the `storage-postgres` `python-interop` test starts the Python adapter against the same database, writes with one language and compare-and-sets with the other. The Python storage contract suite (`tests/storage/_contract.py`) runs the TypeScript contract's cases against memory, file, redis and postgres; the Python sample host selects the backend with `KOHAKU_STORAGE=postgres`, `KOHAKU_POSTGRES_URL` and `KOHAKU_POSTGRES_SCHEMA` like the TypeScript sample. The TypeScript `@kohaku-ui/storage-postgres` is unchanged: it carries no code change in this entry and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.

- [#127](https://github.com/yosuque/kohaku/pull/127) [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a) Thanks [@yosuque](https://github.com/yosuque)! - `StoragePort` gains an optional **compare-and-set**, so several host instances sharing one redis / postgres no longer silently lose each other's promotion-state and fixation updates (SPEC Appendix 12, REST-CONF-001 [Draft], design.md [#79](https://github.com/yosuque/kohaku/issues/79)).
  
  - **spec-core**: `PromotionState.revision?` (also in `PromotionStateSchema` / `spec/schemas`), `StoragePort.supportsCompareAndSet?: true`, a four-state `expectedRevision` option on `putPromotionState`, `putFixation` and `deleteFixation` (omitted = unconditional, `null` = must not exist, `""` = must exist and carry no `revision`, any other string = must equal), the new `StorageConflictError` (`code: "STORAGE_CONFLICT"`) a mismatch throws without writing, and the `CONFLICT` `HostErrorCode`, plus the `singleProcess` marker. Adapters that do not declare the extension may keep ignoring the option, so existing adapters and fake ports stay valid. The batch `putPromotionStates` stays unconditional, so on a port that declares the extension the lineage service writes bulk nominations one candidate at a time, conditional on the revision the scan loaded, and skips a candidate that lost the race (no `component.nominated` for it) instead of rolling back an approve another instance recorded.
  - **storage-memory / storage-redis / storage-postgres**: memory, redis and postgres declare it. The file port honors `expectedRevision` (against the snapshot re-read inside its in-process lock) but does **not** declare `supportsCompareAndSet` — its lock does not span processes, so two processes sharing a data directory can still lose updates — and both it and memory mark themselves `singleProcess: true`. redis uses `WATCH` / `MULTI` / `EXEC` (no Lua) on a dedicated connection it opens lazily from the shared client (offline queue and auto-resend off; a reconnect between WATCH and EXEC is refused as a conflict; close() closes it, even for an injected client; the ACL needs `WATCH` / `UNWATCH`); postgres uses one conditional `UPDATE` / `INSERT ... ON CONFLICT DO NOTHING` / `DELETE` on the payload's JSON `revision` (SQLSTATE `40001` also maps to the conflict), with no schema change. `@kohaku-ui/port-contracts` gets an opt-in `requireCompareAndSet` case group.
  - **lineage**: every promotion snapshot write now carries a fresh `revision` and is conditional on the one the candidate was loaded with; `act()` re-reads the stored revision right before recording its audit event and throws `StorageConflictError` if it moved. Fixation `unfixate` / `invalidate` / `refreshFingerprint` / `replace` pass the revision they read (`fixate` stays an unconditional human overwrite). The persisted promotion state now has a `revision` key.
  - **host-core / host-rest / host-mcp-apps**: `StorageConflictError` is answered with `409 CONFLICT` (REST also reports it to `onError` under `storage.conflict`; the self-heal `invalidate` / `refreshFingerprint` treat a lost race as a silent no-op) and the fixed message `the resource was modified concurrently; reload and retry` (`STORAGE_CONFLICT_MESSAGE`; a new `conflict` kind of `classifyHostError`), never retried inside the host; MCP returns the same message as a tool error; `applyCatalogMigration` reports a lost race as a skipped step.
  - **host**: `createKohakuHost` warns once when a custom `storage` declares neither `supportsCompareAndSet` nor `singleProcess`.
  - **Upgrade note**: a record written before revisions existed is unversioned and is guarded too (a writer that read it expects `""`, "present, no revision"); an old-version writer can still overwrite unconditionally, so upgrade every writer before relying on the extension. A recorded `component.reviewed` approve whose state write lost the race was not applied.
  - Python port (`kohaku-ui` on PyPI): the same, with `UNSET` meaning "no expectation" (and `""` the unversioned-record state) and keyword-only `expected_revision` parameters on the `StoragePort` Protocol methods (a custom Python port with the old signatures now fails type checking; at runtime it keeps working).

### Patch Changes

- [#133](https://github.com/yosuque/kohaku/pull/133) [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d) Thanks [@yosuque](https://github.com/yosuque)! - Storage compare-and-set hardening (follow-up to design.md [#79](https://github.com/yosuque/kohaku/issues/79)).
  
  - **Unversioned records are guarded** (the `""` state of `expectedRevision`, see the compare-and-set note): all CAS adapters read an absent or non-string `revision` as `""`, and `lineage` passes `""` for such a promotion state or fixation, so a legacy record is no longer overwritten unconditionally by the first write.
  - **`persistMany` no longer drops audits on a mid-batch storage error.** It returns `{ persisted, error? }`; `nominateEligible` audits what was stored before the error (`component.nominated`) and only then rethrows it, in the compare-and-set loop, the batch call and the legacy per-item fallback. After a failed write the state is read back, so a write that landed before the error (a timeout after commit) is audited too.
  - **storage-redis: per-command errors in an `EXEC` reply are no longer ignored.** A shared `execOrThrow` throws the first one (for example a WRONGTYPE `ZADD` after the `SET` already applied) as a possibly partially applied transaction, at the compare-and-set path and at `appendLineage`, `deleteFixation`, and both plain indexed writes. It is never mapped to `StorageConflictError`; only a null reply stays the conflict signal.
  - Python port (`kohaku-ui` on PyPI): the same `persist_many` result and read-back; the lineage paging caveat (allocation order is not visibility order, bound a pack with `until`) is now documented on the Python `StoragePort` too.
- Updated dependencies [[`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2), [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee), [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85), [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d), [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a)]:
  - @kohaku-ui/spec-core@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

### Patch Changes

- [#80](https://github.com/yosuque/kohaku/pull/80) [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141) Thanks [@yosuque](https://github.com/yosuque)! - Internal, behavior-preserving refactoring of the composer tier ladder (budget gate, discriminated `TierResult`, L2 lint rule table), the evals judge (pure verdict aggregation), lineage (promotion import cycle, fixation guard/stamp helpers, candidate bulk loader, analytics accumulators), the CLI (shared lineage-source options, scaffold target table), both hosts (compose pipeline module, shared tool-call preamble, inline gate mapping) and the Postgres/Redis adapters (shared WHERE builder and record-table helper). No public API, wire format, persisted format or client-visible message changes.

- [#88](https://github.com/yosuque/kohaku/pull/88) [`2a0bcd6`](https://github.com/yosuque/kohaku/commit/2a0bcd6eb50b5317c79c2e59345f52487b7ca6e6) Thanks [@yosuque](https://github.com/yosuque)! - Review-driven fixes across the host, lineage, storage and CLI packages:
  
  - `@kohaku-ui/host-mcp-apps`: an Action gate that cannot decide (the operation index failing to build, or `ActionGate.check` / `ApprovalPort.verifyApproval` throwing) is now audited as an `action.denied` lineage event through host-core's `recordActionGateUnavailableDenial`, as the REST profile already did, and the tool error carries the fixed `action gate unavailable` message.
  - `@kohaku-ui/host-core`: the console error reporter's non-debug line now names the error type and, when present, its `code` / provider / model (`LlmError[PROVIDER anthropic/...]: ...`) so an operator can tell a provider outage from any other failure; the cause chain and stack stay debug-only.
  - `@kohaku-ui/lineage`: fixation proposals skip `view.composed` records that carry `provenance.fallback` (a fallback Spec can never be fixated, so it no longer shows up as a 100%-stable candidate); the generic promotion `act()` path keeps "audit record first, snapshot second" and now documents why (a lost `component.reviewed` must never let a retried approve() publish without the human-approval evidence); re-approving a published candidate whose draft or html is missing now fails fast instead of passing `undefined` to the projection.
  - `@kohaku-ui/storage-postgres`: the migration advisory-lock wait is bounded (`MIGRATION_LOCK_WAIT_MS`, 60 s) and rejects with the lock key instead of hanging `ready()` forever; the README documents that Spec-cache rows stored without `ttlSeconds` are never swept.
  - `@kohaku-ui/storage-memory`: `listLineage` scans from the tail and stops after `limit` matches instead of filtering the whole log.
  - `@kohaku-ui/semantic-llm`: an empty intent catalog now fails with "the intent catalog is empty" rather than "does not match any intent".
  - `@kohaku-ui/cli`: the `kohaku init` REST server drains gracefully on SIGINT / SIGTERM (`/api/health` turns 503 while shutting down, `KOHAKU_SHUTDOWN_GRACE_MS` bounds the drain, a `start` script is generated), the `init --mcp` server validates `KOHAKU_SHUTDOWN_GRACE_MS`, the `scaffold ports` hints mention the capability secret and the full install line, and the package README lists every command.
- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e)]:
  - @kohaku-ui/spec-core@0.5.0

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

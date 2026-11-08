# @kohaku-ui/storage-redis

## 0.6.0

### Minor Changes

- [#129](https://github.com/yosuque/kohaku/pull/129) [`f43a74c`](https://github.com/yosuque/kohaku/commit/f43a74cd7d2ccd365a2a4f452a420cbceeb6a96c) Thanks [@yosuque](https://github.com/yosuque)! - Python port (`kohaku-ui` on PyPI): new `kohaku.storage.redis` subpackage (extra `redis`, redis-py's asyncio client), the port of this package, data-compatible with it so a TypeScript host and a Python host can serve one Redis. `create_redis_storage_port(url=… | client=…, key_prefix="kohaku")` is a full `StoragePort`: the Spec cache, lineage (append-only hash plus a sorted-set index per field, with the bounded chunked reads behind `list_lineage` and `page_lineage`), promotion state and fixations (one key per tenant and id, with all-tenant and per-tenant indexes), the batch `put_promotion_states`, and the optional compare-and-set (`supports_compare_and_set`, `expected_revision`, `StorageConflictError`) as WATCH / MULTI / EXEC on a connection pinned to the transaction by redis-py's `Pipeline.watch` — no Lua, like the TypeScript adapter. `create_redis_revocation_store` is the Redis `CapabilityRevocationStore` (`{prefix}:revoked:{jti}` with its own TTL). The key layout, the index entries and the stored JSON text are pinned against the TypeScript adapter by the cross-language golden (`storageLayout`), and the `storage-redis` `python-interop` test starts the Python adapter against the same Redis, writes with one language and compare-and-sets with the other. `kohaku.spec` gains `normalize_tenant` and the shared lineage filter (`matches_lineage_filter`, `apply_lineage_limit`, `LINEAGE_PAYLOAD_INDEX_FIELDS`); the Python sample host selects the backend with `KOHAKU_STORAGE=redis` and `KOHAKU_REDIS_URL` like the TypeScript sample. The TypeScript `@kohaku-ui/storage-redis` is unchanged: it carries no code change in this entry and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.

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
- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e)]:
  - @kohaku-ui/spec-core@0.5.0

## 0.4.1

### Patch Changes

- [#42](https://github.com/yosuque/kohaku/pull/42) [`e24d48a`](https://github.com/yosuque/kohaku/commit/e24d48a8fa5a2bfcaa8d3b93d43269fe43b0c7db) Thanks [@dependabot](https://github.com/apps/dependabot)! - Support `ioredis` 6 alongside 5. The peer dependency range is now `^5.11.1 || ^6.0.0`, so a host on `ioredis` 5 installs this release without an `ERESOLVE`. The adapter's behavior is unchanged on both: the one code change is that the `ZRANGE` stop index is passed as the string `"-1"`, which the ioredis 6 typings require and ioredis 5 sends identically on the wire. The package is developed and tested against ioredis 6.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b) Thanks [@yosuque](https://github.com/yosuque)! - `pageLineage` now floors a fractional `pageSize` to an integer before clamping it. spec-core exports `clampLineagePageSize()`, which the array-backed pager and the Redis and Postgres adapters share: a request for `2.5` previously became `LIMIT 3.5` (a Postgres error) and made the page-size bound ineffective for the memory and Redis pagers.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41) Thanks [@yosuque](https://github.com/yosuque)! - The Redis `pageLineage` now scans the field index that `listLineage` already chooses (tenant, correlationId, intentHash, ...) instead of hydrating and filtering the whole log, and stops after a bounded number of chunks per call, returning a short page with a `nextCursor` when the budget runs out. The `pageLineage` contract text now says pages may be short or empty while a cursor is present, and that a cursor can miss an append that was still in flight when it passed (design.md decision 53).
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

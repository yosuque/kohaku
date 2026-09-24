---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/authz-hmac": minor
"@kohaku-ui/authz-jwt": minor
"@kohaku-ui/storage-redis": minor
"@kohaku-ui/storage-postgres": minor
---

Capability tokens can now be revoked before they expire. `@kohaku-ui/spec-core` adds the
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

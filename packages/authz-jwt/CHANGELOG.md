# @kohaku-ui/authz-jwt

## 0.6.0

### Minor Changes

- [#122](https://github.com/yosuque/kohaku/pull/122) [`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2) Thanks [@yosuque](https://github.com/yosuque)! - Capability tokens can now carry a signed `tenant` (SPEC CAP-TEN-001 issuance / CAP-TEN-002 data plane, [Draft]), which fixes `KOHAKU_AUTHZ=jwt` on the REST data plane: `/binding/*` used to resolve no tenant, so an `"approve"`-tier Action could never run (its approval token is bound to the approver's tenant), audit records had no tenant, and the rate limit shared one anonymous bucket.
  
  - `spec-core`: `AuthzPort.issueCapability(…, { ttlSeconds?, tenant? })`, `VerifyResult.tenant?` and `InvocationContext.tenant?` (all optional).
  - `authz-hmac`: the HMAC payload gains an optional `tenant` claim (an older verifier ignores it) and `createHmacAuthzPort({ requireTenant })` refuses tenant-less tokens, like `requireJti`.
  - `authz-jwt`: `createJwtAuthzPort({ requireCapabilityTenant })` passes it through (distinct from the inherited `requireTenant`, which governs the bearer JWT's own claim).
  - `host-core`: `issueCapabilityForSpec`, `issueCapabilityForRefs` and `issueSpecCapabilitySafely` take `options.tenant`.
  - `host-rest`: compose, events, the stream and the promotion preview bind the resolved tenant. `/binding/resolve` and `/binding/action` treat the capability's tenant as authoritative: it reaches `DomainPort.invoke` as `InvocationContext.tenant`, scopes the approval binding and audit records, and a different `deps.tenant` is `403 CAPABILITY_DENIED`. A capability without a tenant still falls back to `deps.tenant`. Behaviour change: the `/binding/*` rate limit now runs inside the handlers after the capability verified, keyed by `(capability tenant, capability sub, routeClass)`, so requests that fail verification no longer consume or hit the limiter.
  
  Also in this change:
  
  - `host-mcp-apps`'s `${prefix}_resolve_binding` and `${prefix}_action` carry a tenant a verified capability binds (for example one minted by REST) through to `domain.invoke`, the approval binding and the audit; MCP still resolves and issues no tenant. (`@kohaku-ui/host-mcp-apps`: minor.)
  - The tenant claim is at most 256 characters with no control characters; `issueCapability` throws on an invalid one and `verify` treats it, or an explicit `null`, as a malformed payload.
  - `/binding/action` checks for the bearer before parsing the body.
  - Observability: `/binding/*` 429s and `onRateLimited` (now with `tenant` set) concern verified token holders only; unauthenticated floods show up as 401, 403 or 400, and are bounded only by the body limit, HMAC verification and (with revocation) a store lookup, so put a coarse IP or route limiter in front of the host.
  - Rollout: enable `requireTenant` / `requireCapabilityTenant` only after every issuing host is upgraded (older tokens are tenant-less for up to the TTL).
  - Python: custom `AuthzPort`s should add `tenant: str | None = None` to `issue_capability` (the value may be ignored). The Protocol now requires it, so the old signature fails mypy; at runtime the REST host degrades to tenant-less issuance for such a port and reports once through `on_error` (`capability.tenant_unsupported`).

### Patch Changes

- [#126](https://github.com/yosuque/kohaku/pull/126) [`1d36145`](https://github.com/yosuque/kohaku/commit/1d36145aaaa7d536139bd9c3e2fe9fdbbddcb2f6) Thanks [@yosuque](https://github.com/yosuque)! - `@kohaku-ui/authz-jwt`: the default claim mapping now rejects a bearer JWT whose tenant claim is over 256 UTF-16 code units or contains a control character, with a new `JwtIdentityError` code `INVALID_TENANT` (a 401 in the sample hosts). Such a tenant used to pass identity resolution and then fail at capability issuance as a 500. `@kohaku-ui/authz-hmac` exports the `isValidTenantClaim` rule so both packages apply the identical check.
- Updated dependencies [[`1d36145`](https://github.com/yosuque/kohaku/commit/1d36145aaaa7d536139bd9c3e2fe9fdbbddcb2f6), [`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2), [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee), [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85), [`f4912b4`](https://github.com/yosuque/kohaku/commit/f4912b47606c8e7595c1bf8642d8a84608f50e75), [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d), [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a)]:
  - @kohaku-ui/authz-hmac@0.6.0
  - @kohaku-ui/spec-core@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

### Patch Changes

- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e)]:
  - @kohaku-ui/authz-hmac@0.5.0
  - @kohaku-ui/spec-core@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`5298e29`](https://github.com/yosuque/kohaku/commit/5298e299c010b6c7b088d9c778f3856a8b96e941), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`9c51dab`](https://github.com/yosuque/kohaku/commit/9c51dab3d986ba1bddc444f8542e41b2e5daa654), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc)]:
  - @kohaku-ui/spec-core@0.4.1
  - @kohaku-ui/authz-hmac@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [[`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/authz-hmac@0.4.0

## 0.3.0

### Minor Changes

- [#32](https://github.com/yosuque/kohaku/pull/32) [`244136c`](https://github.com/yosuque/kohaku/commit/244136c70cb1875c084589c7640ee3fbb3880f4c) Thanks [@yosuque](https://github.com/yosuque)! - Hardens capability revocation and JWT identity resolution, and closes a fail-open gap where a revocation-store
  outage surfaced as an unhandled raw failure instead of a client-safe, observed one.
  
  `@kohaku-ui/authz-hmac`'s `verify` now evaluates the requested scope before consulting the revocation store
  (an out-of-scope request no longer pays for a store round trip), and a store rejection propagates as a thrown
  error rather than being silently swallowed — per `AuthzPort.verify`'s doc comment (`@kohaku-ui/spec-core`'s
  `ports.ts`): verify throws only on infrastructure failure, and a thrown verify is fail-closed, mapped by the
  host to a 5xx. `revokeCapability` now returns `{ ok: true, alreadyExpired: true }` for an already-expired
  token (idempotent success, not a failure) and a coded `"STORE_ERROR"` (instead of throwing) when the
  revocation store itself fails. Expiry is now `exp <= now` consistently across `verify`, `revokeCapability`,
  and the memory store's own sweep (previously `verify`/`revokeCapability` used `exp < now`, off by one second
  at the boundary from the memory store). New `HmacAuthzOptions.requireJti` (default `false`) rejects a
  capability token with no `jti` claim once a fleet has fully rolled onto a `jti`-issuing version.
  
  `@kohaku-ui/authz-jwt`'s `createJwtIdentityResolver` (and `createJwtAuthzPort`, which constructs one) now
  validates its configuration at construction: `audience` is required when `key` is `jwks` or `jwksUrl` (stays
  optional for `secret`); an HS256 `key.secret` must be at least 32 bytes; a `jwksUrl` must use `https:` unless
  the host is `localhost` / `127.0.0.1` / `::1`. New `requireTenant` option (default `false`) rejects a token
  with no (or an empty) tenant claim as `JwtIdentityError({ code: "MISSING_TENANT" })` instead of silently
  widening scope to "no tenant" (only applies to the default claim mapping).
  
  `@kohaku-ui/host-core` adds `verifyCapabilitySafely(authz, token, req, onFailure)` (alongside the existing
  `issueSpecCapabilitySafely`): calls `authz.verify` and returns a discriminated
  `{ kind: "verdict"; verdict } | { kind: "unavailable"; error }` instead of letting a thrown `verify`
  propagate, plus the shared `CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE` client-safe text constant.
  `@kohaku-ui/host-rest`'s `/binding/resolve` and `/binding/action`, and `@kohaku-ui/host-mcp-apps`'s
  `kohaku_resolve_binding` / `kohaku_action` tools, now call it and map `"unavailable"` to a client-safe,
  observed failure (REST: 503 `INTERNAL` with `"capability verification unavailable"`, reported to `onError`;
  MCP: a structured tool error with the same message, reported to `onError`) instead of letting a thrown
  `authz.verify` surface as a raw 500 or an unhandled rejection.

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

### Patch Changes

- Updated dependencies [[`244136c`](https://github.com/yosuque/kohaku/commit/244136c70cb1875c084589c7640ee3fbb3880f4c), [`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e), [`76103a6`](https://github.com/yosuque/kohaku/commit/76103a60caf2bdac87fec1d4241e3e62cf317b5c)]:
  - @kohaku-ui/authz-hmac@0.3.0
  - @kohaku-ui/spec-core@0.3.0

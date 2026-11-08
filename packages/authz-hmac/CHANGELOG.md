# @kohaku-ui/authz-hmac

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

- [#125](https://github.com/yosuque/kohaku/pull/125) [`f4912b4`](https://github.com/yosuque/kohaku/commit/f4912b47606c8e7595c1bf8642d8a84608f50e75) Thanks [@yosuque](https://github.com/yosuque)! - Python port (`kohaku-ui` on PyPI): new `kohaku.authz_hmac` subpackage, the port of this package, moved out of `examples/sales-api` into the library. `create_hmac_authz_port(secret, *, require_jti=False, require_tenant=False, revocation=None)` issues and verifies the capability token with the full claim set `sub / scopes / exp / jti [/ tenant]` and gains pre-expiry revocation (`revoke_capability`, a `CapabilityRevocationStore` Protocol and `RevokeCapabilityResult` in `kohaku.spec`, `create_memory_revocation_store`, `require_jti`); `create_hmac_approval_port(secret, *, store=None)` and `create_memory_approval_store()` are the approval-token port (v2 prefix, derived MAC key, TTL clamp, self-approval refusal) and its single-use store, now with the TS throttled sweep. Tokens are byte-identical to the TypeScript ones — the cross-language golden (`authzHmac`) pins a TS-issued capability and approval token set that the Python port verifies and re-issues exactly; as part of that, a tenant-less approval token now omits the `tenant` claim instead of writing `null`. `DEFAULT_CAPABILITY_TTL_SECONDS` moves to `kohaku.spec` (still re-exported by `kohaku.host_core`), and the library port has no default secret (the old sample port defaulted to a dev secret). The TypeScript `@kohaku-ui/authz-hmac` is unchanged: it carries no code change in this entry and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.

### Patch Changes

- [#126](https://github.com/yosuque/kohaku/pull/126) [`1d36145`](https://github.com/yosuque/kohaku/commit/1d36145aaaa7d536139bd9c3e2fe9fdbbddcb2f6) Thanks [@yosuque](https://github.com/yosuque)! - `@kohaku-ui/authz-jwt`: the default claim mapping now rejects a bearer JWT whose tenant claim is over 256 UTF-16 code units or contains a control character, with a new `JwtIdentityError` code `INVALID_TENANT` (a 401 in the sample hosts). Such a tenant used to pass identity resolution and then fail at capability issuance as a 500. `@kohaku-ui/authz-hmac` exports the `isValidTenantClaim` rule so both packages apply the identical check.
- Updated dependencies [[`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2), [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee), [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85), [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d), [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a)]:
  - @kohaku-ui/spec-core@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

### Patch Changes

- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e)]:
  - @kohaku-ui/spec-core@0.5.0

## 0.4.1

### Patch Changes

- [#64](https://github.com/yosuque/kohaku/pull/64) [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc) Thanks [@yosuque](https://github.com/yosuque)! - `POST /approvals` no longer reports every `issueApproval` failure as a 400 with the raw message: only an `ApprovalIssueError` (or an error carrying `code: "APPROVAL_ISSUE_REJECTED"`, both new in spec-core; `createHmacApprovalPort` throws it for a self-approval) maps to 400, and any other error is reported to `onError` and returned as a fixed-text 500 `INTERNAL` (design.md decision 63). `createHmacApprovalPort` also gains `maxTtlSeconds` (default 3600) that clamps every granted lifetime, so a caller-supplied `ttlSeconds` up to 86400 no longer yields a day-long replay window when no `ApprovalStore` is configured.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`5298e29`](https://github.com/yosuque/kohaku/commit/5298e299c010b6c7b088d9c778f3856a8b96e941) Thanks [@yosuque](https://github.com/yosuque)! - Approval tokens are now domain-separated from capability tokens cryptographically (design.md decision 63): the approval MAC key is derived from the shared secret under its own label and the MAC input covers the token prefix, and the token prefix is bumped to `kohaku-approval.v2.`. Approval tokens issued by an earlier version (`kohaku-approval.v1.`) are rejected after upgrading; they are short-lived (default TTL 300 s), so an approver only needs to re-issue any approval still pending at the moment of the rollout. Both HMAC ports now type-check every decoded claim and return a denial instead of throwing on a correctly signed but malformed payload.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`9c51dab`](https://github.com/yosuque/kohaku/commit/9c51dab3d986ba1bddc444f8542e41b2e5daa654) Thanks [@yosuque](https://github.com/yosuque)! - `createMemoryApprovalStore` sweeps expired entries at most once per second instead of scanning the whole map on every `consume`; an expired but unswept entry still does not count as consumed, so expiry semantics are unchanged.
- Updated dependencies [[`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc)]:
  - @kohaku-ui/spec-core@0.4.1

## 0.4.0

### Minor Changes

- [#62](https://github.com/yosuque/kohaku/pull/62) [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47) Thanks [@yosuque](https://github.com/yosuque)! - Add Governed Actions: Human-In-The-Loop tiers for `DomainPort` write operations (design.md [#62](https://github.com/yosuque/kohaku/issues/62)/[#63](https://github.com/yosuque/kohaku/issues/63)/[#64](https://github.com/yosuque/kohaku/issues/64);
  SPEC §5's ACT-PRM-001/ACT-APR-001/ACT-CNF-001, LIN-ACT-001, §6.2's MCPAPP-ACT-001).
  
  An operation may declare `tier` (`"auto"` (default) / `"confirm"` / `"approve"`) and `paramsSchema`
  (kohaku's own closed JSON Schema subset — `type`, `properties`, `required`,
  `additionalProperties: false`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `items`, `maxItems`,
  `x-message`; deliberately no `pattern`, to avoid both ReDoS and a JS/Python regex-dialect mismatch).
  `spec-core`'s `validateActionParams`/`assertValidActionParamsSchema` (env-neutral, dependency-free, pinned
  byte-for-byte against the Python port via the cross-language golden) enforces the schema before
  `DomainPort.invoke` ever runs, on every write surface alike: REST's `POST /binding/action`, MCP's
  `${prefix}_action`, and the client-side `preflightAction` check `renderer-core` runs before either.
  
  `"approve"`-tier actions are gated by a new stateless, short-lived HMAC-signed `ApprovalPort`
  (`@kohaku-ui/authz-hmac`'s `createHmacApprovalPort`, `"kohaku-approval.v1."`-prefixed tokens, 300s default
  TTL) bound to `(action, payloadHash, requesterId, tenant)`; self-approval is refused at issuance, and a
  verification failure the host cannot classify is treated as a denial (fail-closed). An optional
  `ApprovalStore` adds single-use enforcement. REST gains `POST /approvals` (mints a token as an authorized
  approver, governance kind `action.approve`) and both the REST body and the MCP action tool's input gain
  optional `confirmed`/`approval` fields; a gate failure is `422 ACTION_PARAMS_INVALID` / `403
  APPROVAL_REQUIRED` on REST (with `error.issues`/`error.approval`) and the MCP structured-tool-error
  equivalent.
  
  A compose response optionally carries an **Action manifest** (REST's `actions?` on
  `/compose`/`/events`/`event: spec`; MCP's `_meta["kohaku/actions"]`) mapping each governed action name to
  `{tier, paramsSchema?, confirmMessage?}` — placed outside the `UISpec` itself, next to the capability, so
  it never affects `specHash` or the cache key. `renderer-core`'s `preflightAction` consults it client-side
  before a write round-trip; `renderer-react`/`renderer-wc`/`mcp-renderer` thread `confirm`/`requestApproval`
  hooks through (`renderer-react` ships a `globalThis.confirm`-backed default for the `"confirm"` tier; there
  is no framework-neutral default for `"approve"`, so that tier stays gated until a product wires its own
  hook). `@kohaku-ui/client`/`@kohaku-ui/data-binding` gain typed `ACTION_PARAMS_INVALID`/`APPROVAL_REQUIRED`
  error codes and `confirmed`/`approval` request options. A host that records action outcomes to lineage does
  so under a distinct `action.*` event family (`action.invoked`/`action.denied`/`action.approvalRequested`/
  `action.approved`), carrying `payloadHash` but never the payload's own field values.
  
  The Python port (`python/kohaku`) mirrors the full surface (`kohaku.spec.action_params`,
  `kohaku.host_core.action_gate`/`action_audit`, `POST /approvals`, the MCP action-tool gate), and
  `apps/sample-api` / `python/examples/sales-api` demonstrate both tiers end to end (`annotate`: confirm,
  `publish`: approve) — see the [user guide](../docs/user-guide.md)'s "Governed actions: tiers" section.
  
  **Behavior changes to check when upgrading.** (1) `POST /binding/action` and the MCP action tool now
  reject, before `DomainPort.invoke` runs, any action that is not in the DomainPort's own
  `listOperations()` — previously such an action was invoked ungated. It is rejected with the same response
  as a missing write scope and recorded as `action.denied`. A product whose `listOperations()` omits an
  operation it still expects to be invoked must declare it. (2) `validateActionParams` rejects a payload
  property named `__proto__`, `constructor` or `prototype` at any depth (issue code `unsafeKey`), whatever
  the schema's `additionalProperties` says.

### Patch Changes

- Updated dependencies [[`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/spec-core@0.4.0

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

- [#24](https://github.com/yosuque/kohaku/pull/24) [`76103a6`](https://github.com/yosuque/kohaku/commit/76103a60caf2bdac87fec1d4241e3e62cf317b5c) Thanks [@yosuque](https://github.com/yosuque)! - New packages extracted from the sample: `@kohaku-ui/storage-memory` (`createMemoryStoragePort`, `createFileStoragePort`) and `@kohaku-ui/authz-hmac` (`createHmacAuthzPort`). They are reference implementations of `StoragePort` / `AuthzPort` (the contract stays in `@kohaku-ui/spec-core`) and pass the shared contract suites in the private `@kohaku-ui/port-contracts`.

### Patch Changes

- [#28](https://github.com/yosuque/kohaku/pull/28) [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e) Thanks [@yosuque](https://github.com/yosuque)! - `DEFAULT_CAPABILITY_TTL_SECONDS` (600) is now defined once in `@kohaku-ui/spec-core`, next to `AuthzPort`. `@kohaku-ui/host-core` and `@kohaku-ui/authz-hmac` re-export the same binding instead of each keeping an independent copy, so the three packages can no longer drift out of sync. No behavior change.

- [#32](https://github.com/yosuque/kohaku/pull/32) [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e) Thanks [@yosuque](https://github.com/yosuque)! - Consolidates several StoragePort/AuthzPort idioms that had drifted into per-adapter copies (code review
  findings). `@kohaku-ui/spec-core` adds `normalizeTenant(tenant)` (an empty-string tenant is now always
  equivalent to an unspecified one — the single normalization every StoragePort tenant parameter should use
  before keying or filtering), the lineage-filter primitives `matchesLineageFilter`, `applyLineageLimit`,
  `DEFAULT_LINEAGE_LIMIT` (= 200), and `LINEAGE_PAYLOAD_INDEX_FIELDS`, the `RevokeCapabilityResult` type
  (next to `CapabilityRevocationStore`, now carrying a machine-readable `code`), and the `SchemaSuggestion` /
  `SuggestedDraft` / `SuggestedEvent` wire types (the single definition for what were three independently
  hand-maintained, structurally-identical copies in `@kohaku-ui/lineage`, `@kohaku-ui/evals`, and
  `@kohaku-ui/client`).
  
  `@kohaku-ui/storage-memory`'s `createMemoryStoragePort` / `createFileStoragePort` now use these shared
  helpers instead of their own copies, and `appendLineage` is idempotent by `id` (a duplicate-id append is a
  no-op instead of creating a second entry). `@kohaku-ui/lineage`'s `SchemaSuggestion` / `SuggestedEvent` and
  `@kohaku-ui/evals`' `SchemaExtractionResult` / `SuggestedDraft` are now type aliases of spec-core's
  definitions (no behavior change). `@kohaku-ui/client`'s `SchemaSuggestionView` / `SuggestedEventView` are
  likewise aliases. `@kohaku-ui/authz-hmac`'s `RevokeCapabilityResult` is re-exported from spec-core, and
  `revokeCapability`'s `{ ok: false, reason }` branches now also carry a `code` (`MALFORMED` /
  `INVALID_SIGNATURE` / `NO_JTI`); `verify`'s own result shape is unchanged.
- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0

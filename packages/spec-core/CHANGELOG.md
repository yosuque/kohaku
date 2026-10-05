# @kohaku-ui/spec-core

## 0.5.0

### Patch Changes

- [#81](https://github.com/yosuque/kohaku/pull/81) [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d) Thanks [@yosuque](https://github.com/yosuque)! - Structural refactoring, round two (behavior-preserving):
  
  - `@kohaku-ui/host/mcp-http` (new subpath): `createMcpHttpServer`, the Streamable-HTTP scaffold (Host/Origin guards, echoed-Origin CORS, OPTIONS preflight, size-capped body pre-read, stateless `createMcpHandler` wiring) that `apps/sample-mcp` used to carry inline. `@modelcontextprotocol/node` becomes an optional peer dependency, needed only for this subpath. Defaults follow the server `kohaku init --mcp` generates; every place the sample answers differently is an explicit option. The init template itself still carries its own copy and switches after this release.
  - `@kohaku-ui/host-core`: `buildActionManifestSafely` and `recordComposedAndFallback`, the order-neutral delivery helpers both host profiles now call (each host keeps its own step order and `onError` endpoint names; characterization tests pin them).
  - `@kohaku-ui/spec-core`: `src/ports.ts` is now a barrel over one file per Port under `src/ports/` (plus `theme-tokens.ts`); every exported name and import path is unchanged.
  - `@kohaku-ui/host-rest`: the compose pipeline helpers (capability issuance, fixation host) live in `routes/compose-pipeline.ts`.
  - `@kohaku-ui/cli`: one registration module per command under `cli/src/cli/`, result printers next to their runners as `format*` functions; `--help` output and exit codes are unchanged (pinned by a help snapshot test).

## 0.4.1

### Patch Changes

- [#64](https://github.com/yosuque/kohaku/pull/64) [`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08) Thanks [@yosuque](https://github.com/yosuque)! - Governed-action payload validation now counts `minLength` / `maxLength` in Unicode code points (matching the Python port; a non-BMP character such as an emoji no longer counts twice), and the `ActionGate` rejects a `__proto__` / `constructor` / `prototype` key anywhere in the payload (objects and arrays, any depth) with an `unsafeKey` issue even when the action declares no `paramsSchema`, an undeclared property carries it, or an array has no `items` (design.md decision 62; SPEC ACT-PRM-001). New export: `findUnsafeActionParamKeys`.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a) Thanks [@yosuque](https://github.com/yosuque)! - Types only, no wire change: the pending-approval descriptor is now a named `ApprovalRequiredInfo` type exported from spec-core (typing `ErrorEnvelope["error"]["approval"]` and every consumer, with `issues` typed as `ActionParamIssue[]`), and `ActionManifest` / `ActionManifestEntry` are defined once in spec-core and re-exported from host-core, renderer-core and client under their existing names (design.md decisions 62-64).

- [#64](https://github.com/yosuque/kohaku/pull/64) [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc) Thanks [@yosuque](https://github.com/yosuque)! - `POST /approvals` no longer reports every `issueApproval` failure as a 400 with the raw message: only an `ApprovalIssueError` (or an error carrying `code: "APPROVAL_ISSUE_REJECTED"`, both new in spec-core; `createHmacApprovalPort` throws it for a self-approval) maps to 400, and any other error is reported to `onError` and returned as a fixed-text 500 `INTERNAL` (design.md decision 63). `createHmacApprovalPort` also gains `maxTtlSeconds` (default 3600) that clamps every granted lifetime, so a caller-supplied `ttlSeconds` up to 86400 no longer yields a day-long replay window when no `ApprovalStore` is configured.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d) Thanks [@yosuque](https://github.com/yosuque)! - Compliance Evidence Pack (design.md decision 67): `verifyEvidencePack` now checks the signature over the raw `manifest.json` value before validating its shape, so a field added, removed or retyped after signing no longer verifies (the manifest schemas are strict and have no defaults, and the Python port matches). `buildEvidencePack` refuses to emit a file larger than the 64 MiB cap that verification enforces (new `maxFileBytes` option), instead of producing a pack that cannot be verified, and reports unparseable lines inside signed jsonl content.
  
  `approvals.jsonl` now also indexes `action.approvalRequested`, `action.approved`, `action.denied` and `policy.applied` events, so its bytes (and its manifest hash) change for any pack whose window contains them.
  
  `kohaku evidence export` now validates and canonicalizes `--since` / `--until` like the REST `/lineage` route (via the new `parseIso8601` export of spec-core, which host-rest now imports): `+hh:mm` offsets are converted to UTC, a date-only `--until` includes that whole UTC day, and an invalid or reversed window exits 2 instead of signing a wrongly scoped pack. The client's `lineagePages` and the pack builder throw instead of looping forever when a host returns the cursor it was given.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56) Thanks [@yosuque](https://github.com/yosuque)! - Form field `minLength` / `maxLength` now count Unicode code points, matching the ACT-PRM-001 `paramsSchema` check, so a non-BMP character (an emoji) no longer counts twice on the client. `@kohaku-ui/spec-core` exports `codePointLength` for this.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207) Thanks [@yosuque](https://github.com/yosuque)! - `decodeSeqCursor` now rejects a lineage cursor whose `seq` is fractional, negative or beyond the safe-integer range with `LineageCursorError` (a 400 on the REST routes) instead of surfacing a TypeError or a rewound page. The Python decoder enforces the same bounds.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b) Thanks [@yosuque](https://github.com/yosuque)! - `pageLineage` now floors a fractional `pageSize` to an integer before clamping it. spec-core exports `clampLineagePageSize()`, which the array-backed pager and the Redis and Postgres adapters share: a request for `2.5` previously became `LIMIT 3.5` (a Postgres error) and made the page-size bound ineffective for the memory and Redis pagers.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad) Thanks [@yosuque](https://github.com/yosuque)! - The in-process `RateLimitStore` keeps its stored last-refill time monotonic, so a caller whose clock went backwards no longer makes the next take over-refill the bucket; the `RateLimitStore` contract now says a distributed store must not let clock skew over-refill either. The rate-limit bucket key docs now describe the key accurately (`JSON.stringify` of the triple), and the Python port keeps non-ASCII characters literal in the key so both ports encode it identically (design.md decision 69).

- [#64](https://github.com/yosuque/kohaku/pull/64) [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41) Thanks [@yosuque](https://github.com/yosuque)! - The Redis `pageLineage` now scans the field index that `listLineage` already chooses (tenant, correlationId, intentHash, ...) instead of hydrating and filtering the whole log, and stops after a bounded number of chunks per call, returning a short page with a `nextCursor` when the budget runs out. The `pageLineage` contract text now says pages may be short or empty while a cursor is present, and that a cursor can miss an append that was still in flight when it passed (design.md decision 53).

- [#66](https://github.com/yosuque/kohaku/pull/66) [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc) Thanks [@yosuque](https://github.com/yosuque)! - `parseIso8601` now rejects an impossible calendar date or clock time (`2026-02-30`, `T24:00:00Z`) instead of letting `Date.parse` roll it over, so the REST `/lineage` and `/analytics/summary` routes answer 400 for it, matching the CLI and the Python port.

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

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Closes a validation gap for a directly-specified Intent (`kind: "intent"`): unlike NL/GUI input, it never
  passed through `SemanticPort.normalize` (or any Intent-catalog lookup a `normalize` implementation may
  consult internally), so an unknown canonical or an invalid/unknown param reached `finalizeIntent`
  unchecked — minting a fresh `intentHash` for a request that could never resolve, and previously surfacing
  as a 500 `COMPOSE_FAILED` from deep inside `compose()` instead of a client-caused 422.
  
  `spec-core`'s `SemanticPort` gains an optional `validateIntent?(intent, ctx): Promise<IntentInput>` (new
  exports `IntentValidationError` and `IntentValidationIssue`, `errors.ts`): implement it to reject such a
  request by throwing `IntentValidationError` (`code: "INTENT_INVALID"`, plus a client-safe `issues` array),
  or return the normalized `IntentInput` (e.g. with schema defaults filled in) on success. `host-core`'s
  `resolveIntent` calls it, when present, before `finalizeIntent`, for every host entry point that resolves a
  directly-specified Intent: REST's `/compose`, `/events` (the pre-event `current`), and
  `/fixations/approve`; MCP's compose-family tools and `kohaku_event`'s `current`. Rejected requests write
  nothing to the cache, lineage, or fixation store. `@kohaku-ui/semantic-llm`'s `createLlmSemanticPort`
  implements it by default (backed by a new, optional `IntentCatalogLike.validateParams`), so a product using
  the default SemanticPort gets this for free; a `SemanticPort` that omits `validateIntent` keeps the
  historical unchecked-finalize behavior (backward compatible), and `compose()` called directly from the
  library (bypassing a host entirely) is unvalidated by design — see `docs/design.md` decision [#51](https://github.com/yosuque/kohaku/issues/51).
  
  **Hash-changing behavior, by design**: an already fully-specified directly-specified Intent (every param
  given explicitly, including ones that have a schema default) hashes exactly as it always did. An Intent
  that relied on a catalog's schema default (the param omitted) previously hashed with that field missing;
  after this change, `validateIntent`'s normalized return value — with the default filled in — is what gets
  hashed and finalized instead. A pre-existing fixation keyed on the old (default-omitted) `intentHash` will
  no longer be reached by that same request; re-approving the fixation under the new hash restores it. This
  also changes an incidental status code: composing a promoted Intent after it has been withdrawn (no longer
  in the catalog) now correctly returns 422 `INTENT_INVALID` instead of 500 `COMPOSE_FAILED`, since
  `validateIntent` catches the now-unknown canonical before `compose()` ever runs.
  
  SPEC.md §6.1 gains **REST-INT-002** (SHOULD): a host whose `SemanticPort` implements `validateIntent`
  should reject an unknown canonical / invalid params with 422 `INTENT_INVALID`, leaving no trace in the
  cache, lineage, or fixation store.

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Add `LineageFilter.correlationId` (payload equality) and forward (append-order) paging over the lineage
  log, exposed as the optional `StoragePort.pageLineage` method (implemented by all four reference storage
  adapters), `GET /lineage?order=asc&cursor=&pageSize=` on the REST profile, and `KohakuClient.lineagePages()`
  on the client SDK. Both additions are backward compatible: a request that omits the new query parameters,
  and a `StoragePort` that does not implement `pageLineage`, behave exactly as before.

- [#61](https://github.com/yosuque/kohaku/pull/61) [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0) Thanks [@yosuque](https://github.com/yosuque)! - Add Policy as Code (design.md [#69](https://github.com/yosuque/kohaku/issues/69)/[#70](https://github.com/yosuque/kohaku/issues/70)): a declarative JSON policy file (`KohakuPolicyFileSchema`,
  spec-core) layers per-tenant overrides — `allowL2`, `budget.dailyTokens`, `rateLimits`, `governance.roles`
  — onto a product-supplied base `ComposePolicy`, without a code change or redeploy. `host-core`'s
  `createPolicyRuntime` builds the runtime (`policyFor`, `rateLimiter`, `rolesFor`, `reload`); `loadPolicyFile`
  reads and validates one from disk. Every function-shaped `ComposePolicy` field (`routeTier`, `fewShot`,
  `designSystem`, `fixedSpecs`, `l2Smoke`, `selectComponents`, `extraRules`) has no schema field at all and
  always comes from the base policy.
  
  Add rate limiting: a new `RateLimitStore` port (spec-core) and `createMemoryRateLimitStore`/
  `createRateLimiter` (host-core) back the policy file's `rateLimits` section. The REST profile
  (`host-rest`) checks it before the compose-family routes and returns `429` with a `RATE_LIMITED` error
  envelope and, when reported, an HTTP `Retry-After` header; the client SDK exposes the new
  `KohakuHostError.retryAfterMs`. The MCP Apps profile (`host-mcp-apps`) checks it before its 6 tool
  handlers and returns a structured tool error (`structuredContent.error.code: "RATE_LIMITED"`, with
  `retryAfterMs` when reported) instead. `host-rest` also gains `governancePolicyFromRoles`, a
  `GovernanceEvaluator` that re-resolves a `PolicyRuntime`'s roles on every call rather than baking them in
  once. `@kohaku-ui/lineage` gains a `policy.applied` audit event (`Lineage.policyApplied`), recorded only
  when a policy reload actually changes the effective policy.
  
  **Cache-isolation fix (SPEC CMP-DET-002, new)**: a session's L2 (free-generation) availability
  (`allowL2`/`routeTier`) is now folded into the compose cache key's fingerprint (`policyFingerprint`'s new
  `tierGate` component), so a cache entry produced under an L2-permissive tenant/policy can no longer be
  served to a session where L2 is disallowed. This is additive to `ComposeBudget`, whose `check` hook now
  optionally receives a `BudgetCheckContext` (tenant/tier/spentTokens/elapsedMs) and gains an optional
  `onUsage` hook, fired once per compose that actually generated.
  
  **Compatibility note**: a policy file (or base `ComposePolicy`) that never sets `allowL2` or `routeTier`
  produces a byte-identical fingerprint to before this change — no cache impact. An environment with
  `allowL2: true` or a `routeTier` configured (in code or via a policy file) will see exactly one cache miss
  per previously-cached intent/tenant/policy combination the first time it composes after upgrading, as the
  new `tierGate` fingerprint component takes effect; every subsequent call caches normally.

### Patch Changes

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Hardens JSON input validation against pathologically deep nesting. `JsonObjectSchema` and `JsonValueSchema`
  (`spec-core`) now reject an over-deep value up front, before parsing its structure, rather than only
  checking depth afterward. `host-rest` additionally checks a request body's whole nesting depth immediately
  after `JSON.parse`, ahead of any zod schema. `host-mcp-apps`' tool inputs (`kohaku_action`, `kohaku_event`,
  and the compose family) already declare these same `spec-core` schemas for their JSON-object fields, so
  they are covered by the same fix without any code change of their own.
  
  The existing depth limit (32) is unchanged, and every input that was accepted or rejected before continues
  to be — this only changes how an over-deep input is rejected (a validation error, rather than a resource
  exhaustion of the parsing recursion).
  
  The Python port (`kohaku-ui` on PyPI) gets the matching fix: `host_rest`'s request-body reader now catches
  the `RecursionError` its JSON decoder can raise on a pathologically deep body (previously uncaught), and the
  LLM adapters' structured-output JSON parsing does the same for a pathologically deep model response.

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

## 0.2.0

### Minor Changes

- [#23](https://github.com/yosuque/kohaku/pull/23) [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3) Thanks [@yosuque](https://github.com/yosuque)! - `provenance.generatorVersion` / `provenance.kit` (both MAY, spec/SPEC.md §2.1 Appendix item 13):
  the composer now stamps the Spec's `provenance` with the generator identity (`ComposePolicy.generatorVersion`)
  and design kit (`designSystem.kit`'s `{id, version}`) in effect at composition time, whenever either is
  set — on every tier, and preserved unchanged through a cache hit or an L1→L0 fixation.
  
  `mountSandbox`'s `kitCss?: string` option is now `@deprecated` (kept, unchanged, backward compatible) in
  favor of `kit?: DesignKitStylesheet | string | ((node, spec) => DesignKitStylesheet | string | undefined)`.
  A versioned `DesignKitStylesheet` (`{id, version, css}`) is compared against the Spec's own
  `provenance.kit` and a mismatch is reported via `bridge.onTelemetry({kind: "kit-mismatch"})` — fail-open,
  never blocking rendering (**SPEC-KIT-001**, SHOULD). This closes the gap where a design kit's CSS and
  vocabulary version had no verification mechanism (a vocabulary bump with no matching CSS change, or vice
  versa, previously rendered unstyled markup with no signal).
  
  `kit`'s resolver form, called with the frame's own `node`/`spec`, is available on both `SandboxFrame`
  (React) and `<kohaku-surface>`'s `context.sandbox.kit` (WC, closing the prior React/WC asymmetry). A host
  can read `spec.provenance.kit` inside it to serve each artifact the stylesheet it was actually composed
  against, rather than one stylesheet for the whole surface — replacing `kitCss: ""`'s all-or-nothing
  rollback (previously, silencing a regression in newly generated artifacts by clearing `kitCss` also
  stripped styling from every already-generated artifact under the old kit).
  
  Fully additive: existing `kitCss` callers, and Specs whose provenance carries neither field, are
  unaffected. `PROMPT_REVISION` and `policyFingerprint` are untouched by this change.

- [#23](https://github.com/yosuque/kohaku/pull/23) [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99) Thanks [@yosuque](https://github.com/yosuque)! - Extend the design-token vocabulary beyond colors: `font.family.*`, `font.size.*`, `space.*`, `radius.*`, `shadow.*` and `motion.*` (typed in `KnownThemeTokens`, defaulted in `defaultLightTheme` / `defaultDarkTheme`, resolvable via `resolveSizing`). The L2 design-system prompt now describes them (`PROMPT_REVISION` 12 — cached L2 generations are separated by prompt revision).

- [#23](https://github.com/yosuque/kohaku/pull/23) [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353) Thanks [@yosuque](https://github.com/yosuque)! - Follow-up to the non-color tokens work (`.changeset/l1-parts-tokens.md`): this release settles the two
  places that PR left inconsistent, breaking rather than shimming (0.x, per the deletion-side convention
  this branch has already applied elsewhere).
  
  `@kohaku-ui/renderer-core`:
  
  - Removed the `@deprecated` `FORM_ROOT_STYLE` / `FIELD_ROW_STYLE` (`presenters/form.ts`) and `GAP`
    (`presenters/layout.ts`) constants (no in-repo callers). Use `formRootStyle(sizing)` /
    `fieldRowStyle(sizing)` / `gapFor(sizing, size)` instead — all three already existed alongside them.
  - `sizing: SizingTokens` is now a **required** trailing parameter on the 15 presenter style functions
    that previously defaulted it to the light theme (`formRootStyle`, `fieldRowStyle`,
    `formControlBaseStyle`, `formSubmitButtonStyle`, `actionButtonStyle`, `tabButtonStyle`,
    `dialogTitleStyle`, `toastStyle`, `spreadsheetThStyle`, `spreadsheetSortButtonStyle`,
    `spreadsheetTdStyle`, `spreadsheetCellEditInputStyle`, `spreadsheetFooterBarStyle`,
    `spreadsheetFooterTotalStyle`, `spreadsheetPagerButtonStyle`), matching every other presenter style
    function, which already required it. `DEFAULT_SIZING` stays exported for external callers: pass it
    explicitly to reproduce the exact values a call with no `sizing` argument used to resolve.
  - The L2 sandbox badge/notice chrome (`presenters/sandbox-chrome.ts`) and the overlay dialog
    (`presenters/overlay.ts`) no longer re-resolve non-color tokens from `theme` on every call.
    `sandboxBadgeRowStyle` / `sandboxBadgePillStyle` gain a required trailing `sizing: SizingTokens`
    parameter; `sandboxNoticeBaseStyle`'s signature changes from `(theme)` to `(sizing)` (it never read a
    color token, so `theme` is dropped rather than kept unused); `dialogBoxStyle` gains a required trailing
    `sizing` parameter (after `accentBorder`); `dialogCloseButtonStyle` / `dialogDescriptionStyle` gain a
    required trailing `sizing` parameter. `sandboxBadgeDescriptionStyle` and `sandboxNoticeToneStyle` are
    colors-only and are unchanged. Both renderers' own call sites (`@kohaku-ui/sandbox`'s `SandboxFrame`,
    renderer-wc's `sandbox-mount.ts` / `parts/overlay.ts`, renderer-react's `core/overlay.tsx`) already pass
    their once-per-render resolved `sizing` (`useSizing()` / `RenderRuntime.sizing`), so this is a pure
    signature change for them — no behavior change, no new resolution cost.
  - `SizingTokens` is renamed to `NonColorTokens` (6 of its 22 fields — `fontSans`/`fontMono`,
    `shadowSm`/`shadowMd`, `motionDuration`/`motionEasing` — were never sizes, and the docs and this file's
    own comments already called the group "non-color tokens"). `SizingTokens` remains exported as a type
    alias (`export type SizingTokens = NonColorTokens`), so existing type annotations keep compiling
    unchanged. `resolveSizing` / `useSizing` / `RenderRuntime.sizing` keep their names (unifying that
    naming is a separate follow-up).
  
  - `dialogOverlayStyle` / `dialogHeaderStyle` / `toastDismissButtonStyle` (`presenters/overlay.ts`) were the
    last plain `const` style objects in `overlay.ts` and are now functions, matching every other style export
    in the file: `dialogOverlayStyle(theme, sizing)`, `dialogHeaderStyle(sizing)`,
    `toastDismissButtonStyle(sizing)`. This also finishes tokenizing the file's remaining literals
    (`dialogOverlayStyle`'s padding, `dialogHeaderStyle`'s gap, `dialogBoxStyle`'s `calc()` max-height,
    `toastStyle`'s bottom offset, `toastDismissButtonStyle`'s font size) and `text-style.ts`'s
    `textListStyle`/`textCodeStyle` padding — both renderers' own call sites already resolve `theme`/`sizing`
    once per render, so this is a pure signature change for them.
  - New token `color.scrim` (`@kohaku-ui/spec-core`'s `KnownThemeTokens`): the dialog backdrop color, now
    themeable instead of a hard-coded `rgba(17, 24, 39, 0.45)` (dark theme gets its own heavier value). Like
    `color.danger` / `color.focus` / `chart.palette`, it is excluded from the L2 generation vocabulary (the
    sandbox never renders a dialog), so this does not change `designSystemPromptFragment`'s output or
    `PROMPT_REVISION`.
  
  `@kohaku-ui/renderer-react`:
  
  - `RendererContextValue.renderSandbox` gains a 3rd parameter: `(node, spec, theme) => ReactNode`.
    `SpecView` now calls it with the provider's own `theme` (the same value `useRenderer().theme` /
    `useToken`/`useSizing` already read), so a host no longer needs to thread `theme` through its own
    closure to keep `SandboxFrame` in sync with the surface's theme — it can read the 3rd argument instead.
    Fully additive for an existing 2-argument implementation (still type-checks and runs unchanged, the
    extra argument is simply ignored); the sample app (`apps/sample-web`) and the React/WC parity harness
    have been migrated to the new argument, dropping their own manual `theme` closures.

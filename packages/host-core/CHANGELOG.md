# @kohaku-ui/host-core

## 0.4.0

### Minor Changes

- [#58](https://github.com/yosuque/kohaku/pull/58) [`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f) Thanks [@yosuque](https://github.com/yosuque)! - Add catalog migration: deprecate a part, roll out a replacement gradually, and bulk-rewrite the fixations
  still pinned on the old one (see `docs/design.md` decision [#65](https://github.com/yosuque/kohaku/issues/65)).
  
  - `@kohaku-ui/registry`: `ComponentDefinition` gains `deprecated?` (`{reason, since?, replacedBy?: {type,
    version?}, sunset?}`) and a TS-only `migrateProps?(props)` hook next to `fallback`. `resolveCatalog`
    validates that every `replacedBy` resolves in the merged catalog. A deprecated part drops out of the L1
    generation vocabulary but keeps validating Specs that already reference it, and the catalog fingerprint
    folds in a `!deprecated` suffix per such entry (every other entry's fingerprint contribution is
    unaffected). New `stagedCatalogFor({ stable, next, inRollout })` builds a `catalogFor`-shaped function for
    canary-rolling a migrated catalog in per tenant (tenant-neutral traffic always gets `stable`).
  - `@kohaku-ui/lineage`: `FIXATION_EVENT_TYPES` gains `intent.migrated`, recorded by a new
    `Fixations.replace(intentHash, pinnedSpec, { approver, guard, planId })` that rewrites a fixation's
    pinned structure in place (TOCTOU-guarded on the caller's observed revision/fixatedAt/structureHash/
    catalogFingerprint). `PromotionCandidate` also gains `origin` (kit/generatorVersion/model, read from
    `component.generated` and kept across every transition) — a promotion-review gap noted since U2.
  - `@kohaku-ui/host-core`: new `analyzeCatalogImpact` (broken fixations, deprecated-part usage, published
    promotions on a deprecated/removed part, origin-kit mismatches) and `planCatalogMigration` /
    `applyCatalogMigration` / `verifyCatalogMigrationPlan` (plan a bulk rewrite, revalidate it against the
    target catalog, then commit it through a host-supplied fixation-replace surface).
  - `@kohaku-ui/host-rest`: `GET /catalog` now serializes `deprecated` on each component (MAY, omitted when
    the part isn't deprecated).
  - `@kohaku-ui/client`: `SerializedComponentDef` / `CatalogResponse` gain `deprecated` /
    `SerializedDeprecation`; `PromotionCandidateView` gains `origin` / `PromotionOriginView`.
  - `@kohaku-ui/cli`: new `kohaku migrate plan --data-dir --catalog --out` (read-only) and `kohaku migrate
    apply --plan --approver --data-dir` (commits it; not safe to run concurrently with a live host sharing
    `--data-dir`).
  - `@kohaku-ui/admin-react`: the promotion card shows the candidate's generation kit/generatorVersion when
    known (`origin`, EN + JA copy).
  
  Fully additive: a catalog with no deprecated parts, a fixation store with no `intent.migrated` events, and a
  promotion record with no `origin` are all byte-identical to before this change.

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

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Add `kohaku explain <requestId>` and Kohaku DevTools (`@kohaku-ui/admin-react/devtools`), answering "why
  did this view come out this way" from a request id alone: tier, cache hit/miss, the cache key's individual
  components, the L1/L2 decision flow (attempts, capability-negotiation downgrades, single-flight
  coalescing, token usage), capability scopes, and the related lineage events.
  
  - `ComposeTrace.cacheKeyParts` records the exact `CacheKeyParts` a compose's `cacheKey` was built from
    (the opaque, colon-joined `cacheKey` string cannot be split back apart after the fact).
  - `view.composed` / `component.generated` / `component.used` / `view.fallback` lineage payloads gain
    `correlationId`, `cacheKey`, `cacheKeyParts`, `generatorVersion`, `kit`, `fallback`, and a `decision`
    summary — all optional and omitted when unset, so every pre-existing event keeps its exact shape.
  - `host-mcp-apps`' MCP compose correlation id is now `mcp:<sessionId>:<jsonrpc id>` (or `mcp:<jsonrpc id>`
    for a session-less transport such as stdio), replacing the bare JSON-RPC request id.
  - `@kohaku-ui/client` reads a compose response's `X-Request-Id` header (`ComposeView.requestId`, the
    stream's `done` event), adds `KohakuClientConfig.onResponse`, and exposes `client.explain(requestId)` /
    the pure `buildExplainReport(events, spec?)`.
  - `kohaku explain <requestId> --rest <baseUrl>` renders the explain report as text or JSON (`--json`),
    optionally with capability scopes (`--spec <file>`).
  - `@kohaku-ui/admin-react/devtools`'s `KohakuDevTools` component (+ `withDevToolsCapture` for a
    "recent requests" quick-pick) renders the same report across six panels, on its own subpath decoupled
    from `AdminProvider`/`KohakuAdmin` (same dependency boundary as the package root: client / renderer-core
    / sandbox / spec-core only, never `renderer-react`).
  
  See docs/user-guide.md's "Kohaku DevTools and `kohaku explain`" section, including the
  `Access-Control-Expose-Headers: X-Request-Id` CORS requirement for a browser-hosted client.

### Patch Changes

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Makes a fallback's reason and an `onError` observation honest about *why* generation degraded, instead of
  collapsing every non-happy-path into the same wording.
  
  `composer`'s L1 tier ladder previously returned the identical "L1 constrained generation failed
  catalog/structure validation" reason whether the LLM provider was actually unreachable (a transient
  error) or the model answered but its output failed validation. A transient failure now gets its own
  reason naming the provider (with the underlying `LlmError` code in parentheses when known, e.g. "(provider
  error)") and pointing at `KOHAKU_LLM_PROVIDER`/the provider API key; the validation-failure wording is
  unchanged. New `ComposeErrorContext.failure` and `TierResult.lastError` let `observer.onError` receive the
  classified failure kind and the underlying error (previously always `undefined` for a fallback) without
  string-matching `reason`.
  
  `refs.ts`'s `SEMANTIC_FAILED` wrapping now appends a `resolveQuery` failure's own message when the cause
  explicitly opts in with a readonly `clientSafe: true` property, so e.g. an unknown Intent name reaches the
  caller instead of the generic "query resolution failed" alone. This is deliberately narrower than "any
  error with a string `code`" (host-core's existing `isTypedHostError` convention): a `SemanticPort` commonly
  delegates to a database/filesystem/HTTP client whose own errors also carry a string `code` (e.g.
  `ECONNREFUSED`) while their `message` can contain hostnames, paths, or table names, so `code` alone is not
  safe to trust here — every cause without `clientSafe: true` is left exactly as before. `semantic-llm`'s
  `resolveQuery` now throws a typed `UnknownIntentError` (exported, `clientSafe: true`) instead of a plain
  `Error`, so its own unknown-intent failures benefit from this.
  
  New `host-core` `formatErrorChain` (walks `Error.cause`, depth-capped against cycles) and
  `createConsoleErrorReporter` (a pair of handlers pre-wired to `KohakuHostDeps.onError` and
  `ComposeObserver.onError`'s exact signatures) give a generated project sensible default logging.
  `kohaku init` wires both hooks in the generated `app.ts`, gated by a new `KOHAKU_DEBUG` env var
  (documented in `.env.example`): unset/any other value keeps today's one-line summaries, `KOHAKU_DEBUG=1`
  prints the full cause chain and stack trace instead.
- Updated dependencies [[`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049)]:
  - @kohaku-ui/registry@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/data-binding@0.4.0
  - @kohaku-ui/composer@0.4.0

## 0.3.0

### Patch Changes

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

- [#28](https://github.com/yosuque/kohaku/pull/28) [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e) Thanks [@yosuque](https://github.com/yosuque)! - `DEFAULT_CAPABILITY_TTL_SECONDS` (600) is now defined once in `@kohaku-ui/spec-core`, next to `AuthzPort`. `@kohaku-ui/host-core` and `@kohaku-ui/authz-hmac` re-export the same binding instead of each keeping an independent copy, so the three packages can no longer drift out of sync. No behavior change.
- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/composer@0.3.0
  - @kohaku-ui/data-binding@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/data-binding@0.2.0

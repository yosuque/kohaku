# @kohaku-ui/host-mcp-apps

## 0.4.1

### Patch Changes

- [#64](https://github.com/yosuque/kohaku/pull/64) [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a) Thanks [@yosuque](https://github.com/yosuque)! - Types only, no wire change: the pending-approval descriptor is now a named `ApprovalRequiredInfo` type exported from spec-core (typing `ErrorEnvelope["error"]["approval"]` and every consumer, with `issues` typed as `ActionParamIssue[]`), and `ActionManifest` / `ActionManifestEntry` are defined once in spec-core and re-exported from host-core, renderer-core and client under their existing names (design.md decisions 62-64).

- [#72](https://github.com/yosuque/kohaku/pull/72) [`92ff930`](https://github.com/yosuque/kohaku/commit/92ff930f683391e2cd4de2a19b66a2e9ca04d49d) Thanks [@yosuque](https://github.com/yosuque)! - An LLM provider that cannot serve Intent resolution (API key not set, provider failure or timeout, aborted call: an `LlmError` with code `PROVIDER` / `CONFIG` / `ABORTED`) is no longer reported as `422 INTENT_INVALID` carrying the provider SDK's raw wording (for example "Anthropic API key is missing…"). `/intent/normalize`, `/events`, `/compose` / `/compose/stream` with a natural-language `input` and `/fixations/approve` now answer 503 `INTERNAL` with the fixed message `LLM provider unavailable; see the host's observability hook (onError) for details`, and the MCP tools return the same text as a structured tool error (and, for a task-backed `kohaku_compose` under the MCP Tasks extension, as the failed task's message instead of the raw `errorMessage`); the original error still reaches `onError`. `/compose` with a directly-specified Intent is unchanged (200 with `provenance.fallback`), and unknown-Intent / invalid-param / no-match failures keep their 422 and their own message. `isTypedHostError` now excludes `LlmError` from its "an Error with a string `code` is typed" rule, so an `LlmError`'s raw message never reaches a client through `clientMessageFor`. New host-core exports: `classifyHostError`, `isLlmUnavailableError`, `LLM_PROVIDER_UNAVAILABLE_MESSAGE`, `HostErrorClass`; `@kohaku-ui/llm` moves from a devDependency to a dependency of host-core.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`564d936`](https://github.com/yosuque/kohaku/commit/564d9369946d0c9e7b12585d8e0d7956135aa1db) Thanks [@yosuque](https://github.com/yosuque)! - `${prefix}_action` now rejects a `__proto__` key anywhere in `payload` with the structured `ACTION_PARAMS_INVALID` / `unsafeKey` error (design.md decision 62; SPEC ACT-PRM-001). The tool's input schema used to drop that key silently while parsing, so the action gate never saw it and the write ran with the key removed. A non-object or over-deep payload is now a tool error from the handler instead of an SDK input-validation error.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`de43fd1`](https://github.com/yosuque/kohaku/commit/de43fd11f926c5a8516997e8134f45c628517209) Thanks [@yosuque](https://github.com/yosuque)! - The MCP correlation id (`mcp:<session or per-call uuid>:<jsonrpc id>`) is now bounded: a client-controlled JSON-RPC or session id that is over 64 characters or not printable ASCII is replaced by a short sha256 digest, so an oversized id can no longer make a lineage write (indexed `correlationId` column) fail. Compose-family tool results now also carry the id in `_meta["kohaku/requestId"]` (new export `REQUEST_ID_META_KEY`), which is where a caller gets the value to pass to `kohaku explain`.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`806c5f2`](https://github.com/yosuque/kohaku/commit/806c5f222097eaf6599a1fc12a5c24c11e83886f) Thanks [@yosuque](https://github.com/yosuque)! - `McpHostDeps.onError` now receives an optional `correlationId` (the call's `mcp:...` id, the same value lineage events and `_meta["kohaku/requestId"]` carry) when the failing path has a tool call in hand, matching the Python port's `McpErrorInfo`. `createConsoleErrorReporter().mcp` prints it as `(correlation <id>)`.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`643ee07`](https://github.com/yosuque/kohaku/commit/643ee070fe2eb84b9186b0bb9db7f5f767a4d4c0) Thanks [@yosuque](https://github.com/yosuque)! - The MCP rate-limit bucket key doc no longer claims a session id exists on Streamable HTTP (the stateless `createMcpHandler` serving has none, so every caller shared the `"anonymous"` bucket): a rate limiter wired without `resolvePrincipal` or the new `rateLimitKey(extra)` hook now warns once at attach, and a new `onRateLimited` observer reports denials. The correlation id of a session-less call is now `mcp:<per-call uuid>:<jsonrpc id>` instead of the colliding `mcp:<jsonrpc id>`.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`be2d02b`](https://github.com/yosuque/kohaku/commit/be2d02b70224683f49210ab0be2d98298efbad00) Thanks [@yosuque](https://github.com/yosuque)! - The one-time warning for a `rateLimiter` wired without `resolvePrincipal` or `rateLimitKey` now also says that on a stateful transport the per-session bucket can be shed by opening a new session, and the `McpHostDeps.rateLimiter` docs recommend `rateLimitKey` / `resolvePrincipal` in production.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`a47d21d`](https://github.com/yosuque/kohaku/commit/a47d21d8b0b6cfdddb08a7f4e53608147c8d272b) Thanks [@yosuque](https://github.com/yosuque)! - `attachKohakuToMcpServer` now shares one operation index (and its one-time `paramsSchema` validation) per `DomainPort` instead of building a new one per attach. A stateless HTTP host that re-attaches on every exchange no longer calls `DomainPort.listOperations()` on each request or re-reports the same invalid `paramsSchema` to `onError` every time (design.md decision 62).

- [#64](https://github.com/yosuque/kohaku/pull/64) [`adb2744`](https://github.com/yosuque/kohaku/commit/adb27442a9169eb74e803e88ec52d54db3a944b2) Thanks [@yosuque](https://github.com/yosuque)! - The MCP `kohaku_action` tool now audits an undeclared action as `action.denied`, exactly as REST's `POST /binding/action` does (SPEC MCPAPP-ACT-001, LIN-ACT-001); the undeclared-action check moved after capability verification and now reads the same operation index the gate uses, and the capability write-scope filter is derived from that index instead of a second `listOperations()` read. host-core gains `recordActionGateResult` / `recordUndeclaredActionDenial` (the shared gate-result audit trail and the confirmation / approval-token messages) and `allowedActionsFromIndex`, which both hosts now call (design.md decisions 62/63).
  
  Both hosts also build the operation index eagerly at attach and report a failure (for example a `paramsSchema` outside the closed subset) through `onError` with endpoint `attach.operationIndex`, instead of only at the first invoke.
  
  An operation whose `paramsSchema` is outside the closed subset no longer fails the whole operation index: `OperationIndexEntry` gains `schemaError`, the operation stays declared (its capability write scope and the undeclared-action check are unaffected, on REST and MCP alike), it is omitted from the `actions` manifest, and invoking it fails closed (REST 500, MCP tool error) while other operations keep working. host-core also exports `validateOperationIndex`, which both hosts call at attach.
- Updated dependencies [[`67828f4`](https://github.com/yosuque/kohaku/commit/67828f4150934eb42a61b25f44390b4c0bacf604), [`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`6b01a1f`](https://github.com/yosuque/kohaku/commit/6b01a1fe0e8ac5f640bbc0a482a3dbe43e6b353a), [`0c4d5a2`](https://github.com/yosuque/kohaku/commit/0c4d5a298ccabe2ca47cac00f4c33730c2b915b0), [`8eb466b`](https://github.com/yosuque/kohaku/commit/8eb466bc52a5259e897d1cbc1713e57796a702e7), [`5bb982e`](https://github.com/yosuque/kohaku/commit/5bb982e2fca7d4c609d5b99b6dc71bac95dbfe55), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`5cfd417`](https://github.com/yosuque/kohaku/commit/5cfd417a7959c03a00587ad22b920b7fe62bf045), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`92ff930`](https://github.com/yosuque/kohaku/commit/92ff930f683391e2cd4de2a19b66a2e9ca04d49d), [`806c5f2`](https://github.com/yosuque/kohaku/commit/806c5f222097eaf6599a1fc12a5c24c11e83886f), [`1e0d356`](https://github.com/yosuque/kohaku/commit/1e0d3564d6296bdae557e5d96376c798a3759b5f), [`7fa1981`](https://github.com/yosuque/kohaku/commit/7fa1981c6e574ba3e9f4eb570b88304c65565011), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`8bd2e93`](https://github.com/yosuque/kohaku/commit/8bd2e93a305b2cfb12ddc394a8044b9dd9ca6378), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`837b4d2`](https://github.com/yosuque/kohaku/commit/837b4d27d3273daa9aa9d33b94e27c041a30c0ff), [`adb2744`](https://github.com/yosuque/kohaku/commit/adb27442a9169eb74e803e88ec52d54db3a944b2), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc), [`718b9e0`](https://github.com/yosuque/kohaku/commit/718b9e01c9f015881cc49db41af26e1d54c53519)]:
  - @kohaku-ui/host-core@0.4.1
  - @kohaku-ui/spec-core@0.4.1
  - @kohaku-ui/data-binding@0.4.1
  - @kohaku-ui/composer@0.4.1

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
- Updated dependencies [[`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049)]:
  - @kohaku-ui/host-core@0.4.0
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
- Updated dependencies [[`244136c`](https://github.com/yosuque/kohaku/commit/244136c70cb1875c084589c7640ee3fbb3880f4c), [`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/host-core@0.3.0
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/composer@0.3.0
  - @kohaku-ui/data-binding@0.3.0

## 0.2.0

### Patch Changes

- [#18](https://github.com/yosuque/kohaku/pull/18) [`6832862`](https://github.com/yosuque/kohaku/commit/68328625443a848307e3fb70aff7b1c757c08bea) Thanks [@yosuque](https://github.com/yosuque)! - Declare `@modelcontextprotocol/server` as a peer dependency instead of a regular dependency. `attachKohakuToMcpServer` attaches to the `McpServer` the application constructs, so the application and kohaku must share one copy of the SDK (the same rule this workspace already applies to `zod`). Add `@modelcontextprotocol/server` to your own dependencies if it is not there yet.

- [#9](https://github.com/yosuque/kohaku/pull/9) [`4feec33`](https://github.com/yosuque/kohaku/commit/4feec33c200ae6174129e9ce0846c1550ed8bc0f) Thanks [@yosuque](https://github.com/yosuque)! - Add `McpHostDeps.resolvePrincipal` (TS) / `resolve_principal` (Python) to resolve the caller's identity per tool call instead of once per attached server, fail-closed on a throw, so a shared Streamable HTTP deployment no longer has to run every connection under one static `principal`.

- [#10](https://github.com/yosuque/kohaku/pull/10) [`824b1d4`](https://github.com/yosuque/kohaku/commit/824b1d467b0af846b5f6cbfa78a1a9af81babdfa) Thanks [@yosuque](https://github.com/yosuque)! - Move the Python MCP host (`kohaku-ui[mcp]`) onto the `mcp` 2.x SDK, raising its floor to `>=2.2`. `attach_kohaku_to_mcp_server`'s public signature is unchanged, but `McpHostDeps.resolve_principal` now takes `ctx: ServerRequestContext` directly (no longer `| None`) — a product-supplied resolver reading `ctx.meta` should switch from attribute access (`getattr(ctx.meta, "key", None)`) to dict access (`ctx.meta.get("key")`), since `meta` is now a `RequestParamsMeta` TypedDict rather than an object. `resources/read` also gains `ttl_ms`/`cache_scope` cache hints, closing a gap the Python host previously had relative to TS.
- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/host-core@0.2.0
  - @kohaku-ui/data-binding@0.2.0

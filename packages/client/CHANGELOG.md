# @kohaku-ui/client

## 0.4.1

### Patch Changes

- [#64](https://github.com/yosuque/kohaku/pull/64) [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a) Thanks [@yosuque](https://github.com/yosuque)! - Types only, no wire change: the pending-approval descriptor is now a named `ApprovalRequiredInfo` type exported from spec-core (typing `ErrorEnvelope["error"]["approval"]` and every consumer, with `issues` typed as `ActionParamIssue[]`), and `ActionManifest` / `ActionManifestEntry` are defined once in spec-core and re-exported from host-core, renderer-core and client under their existing names (design.md decisions 62-64).

- [#66](https://github.com/yosuque/kohaku/pull/66) [`6bb1769`](https://github.com/yosuque/kohaku/commit/6bb1769feb9eed35f32e8e489453ceea6c932745) Thanks [@yosuque](https://github.com/yosuque)! - `KohakuClient` gains `approvals.issue({ action, payloadHash, requesterId, ttlSeconds? })`, a typed wrapper over `POST /approvals` (SPEC ACT-APR-001) that returns `{ approval }`; new exports `ApprovalsClient`, `ApprovalIssueRequest` and `ApprovalIssueResult`. A type-level test now pins the client's `ExplainDecision*` types as assignable from lineage's view.composed decision summary.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d) Thanks [@yosuque](https://github.com/yosuque)! - Compliance Evidence Pack (design.md decision 67): `verifyEvidencePack` now checks the signature over the raw `manifest.json` value before validating its shape, so a field added, removed or retyped after signing no longer verifies (the manifest schemas are strict and have no defaults, and the Python port matches). `buildEvidencePack` refuses to emit a file larger than the 64 MiB cap that verification enforces (new `maxFileBytes` option), instead of producing a pack that cannot be verified, and reports unparseable lines inside signed jsonl content.
  
  `approvals.jsonl` now also indexes `action.approvalRequested`, `action.approved`, `action.denied` and `policy.applied` events, so its bytes (and its manifest hash) change for any pack whose window contains them.
  
  `kohaku evidence export` now validates and canonicalizes `--since` / `--until` like the REST `/lineage` route (via the new `parseIso8601` export of spec-core, which host-rest now imports): `+hh:mm` offsets are converted to UTC, a date-only `--until` includes that whole UTC day, and an invalid or reversed window exits 2 instead of signing a wrongly scoped pack. The client's `lineagePages` and the pack builder throw instead of looping forever when a host returns the cursor it was given.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41) Thanks [@yosuque](https://github.com/yosuque)! - The Redis `pageLineage` now scans the field index that `listLineage` already chooses (tenant, correlationId, intentHash, ...) instead of hydrating and filtering the whole log, and stops after a bounded number of chunks per call, returning a short page with a `nextCursor` when the budget runs out. The `pageLineage` contract text now says pages may be short or empty while a cursor is present, and that a cursor can miss an append that was still in flight when it passed (design.md decision 53).

- [#76](https://github.com/yosuque/kohaku/pull/76) [`656de8e`](https://github.com/yosuque/kohaku/commit/656de8ec3aeb1ee311e25688b88437d450d9dfd9) Thanks [@yosuque](https://github.com/yosuque)! - Reviewer schema corrections now feed back into the schema extractor (design.md [#73](https://github.com/yosuque/kohaku/issues/73)), and the Analytics tab reports the catalog gaps. `@kohaku-ui/evals`: `createSchemaExtractor` takes `examples` / `maxExamples` (default 2, at most 5) and adds a "Reviewer-corrected examples" section to its prompt only when there is at least one example (a throwing, rejecting or aborted provider is treated as none; each draft JSON is cut to 4000 characters); the provider receives the extraction input and a signal for its own short budget `examplesTimeoutMs` (default `min(3000, timeoutMs / 4)` ms; a slow read costs the suggestion its examples, never the suggestion, and the LLM call keeps the whole `timeoutMs`), and `SchemaExtractionInput` gains an optional `tenant`; `SCHEMA_EXTRACTOR_VERSION` is now `"0.2"`, which is stamped onto every suggestion and `component.schemaEdited`. `@kohaku-ui/lineage`: new `schemaEditExamples(storage, { limit })` mines those examples from the lineage log (one read of the reviewer edits, nothing more when none changed a suggestion, then a lookup by `artifactId` for each of the at most `limit` artifacts it uses, and a per-tenant memo of the result for `cacheTtlMs`, default 5 s, so a nomination pass does not re-read the log per candidate; an input with a `tenant` reads only that tenant's records, one without only tenant-less records, so a process-wide extractor never shows one tenant's components while extracting for another); `LineageSummary` gains `l2ByIntent` and `schemaEditsByComponent` (additive fields of `GET /analytics/summary`); `ComponentSchemaEditedPayload` now declares the `acknowledged` field the service already recorded. `l2ByIntent` counts real generations apart from fallbacks (see the usage-metering changeset for the definition) and reads fallbacks off `view.composed`, so an Intent whose L2 only ever fails shows with `generated: 0`. `@kohaku-ui/client` types the two fields as optional, and `@kohaku-ui/admin-react`'s Analytics tab gains a "Catalog gaps" section (Intents going to L2, most-edited schemas, promotions awaiting action via the new `usePendingPromotionCount` hook, which counts with one `GET /promotions?status=` per pending status: a 401 / 403 shows "—" silently, any other failure raises one notice).

- [#76](https://github.com/yosuque/kohaku/pull/76) [`632f2d8`](https://github.com/yosuque/kohaku/commit/632f2d8f711bf73192f026973876e068ec4837bf) Thanks [@yosuque](https://github.com/yosuque)! - Usage metering derived from lineage (design.md [#74](https://github.com/yosuque/kohaku/issues/74)). `@kohaku-ui/lineage` adds the pure `summarizeUsage` (per-day, per-tenant rows: compositions, cache outcomes, tiers, L2 generations, fallbacks, LLM tokens from `view.composed`'s `decision.usage`, fixations), `mergeUsageRows` (adds two row lists key by key, so pages can be folded one at a time) `iterateLineagePages` (the cursor loop over a source's `pageLineage`, refusing a cursor that does not advance, now shared by the evidence pack builder and the usage export) and `LineageSummary.usage`, so `GET /analytics/summary` gains a `summary.usage` array (additive; the wire is otherwise unchanged). `l2Generated` counts the composes that actually generated an L2 Spec and succeeded: a record whose `payload.fallback` has kind `generation` or no kind (which keeps the L2 label when generation fails or the budget skips L2) and a single-flight follower (`decision.coalesced`) are not counted, while a negotiation downgrade (`fallback.kind` `negotiation`, applied to a Spec that was generated and paid for) is; `fallbacks` counts the `view.composed` records that carry `payload.fallback`, not `view.fallback` (the REST and the MCP profile both record one next to the composed record, so counting both would double-count). The Python `kohaku.lineage` mirrors both, plus `merge_usage_rows`. `@kohaku-ui/client` types it as `UsageRowView` (the new summary fields are optional there, since an older host omits them), and the admin Analytics tab shows a "Usage by day" table, labelled as a sample of the most recent events, with the fixation columns named for what they count (composes served from a fixation vs. fixation operations, the latter named `fixationsCreated` / `fixationsRemoved` in the rows and `fixations_created` / `fixations_removed` in the CSV). `@kohaku-ui/cli` adds `kohaku usage export` (`--data-dir` or `--rest`, `--since` / `--until`, `--format csv|json`, `--out`), which reads the whole lineage log, folding each chunk into the running rows instead of holding every event (`--data-dir` streams `lineage.jsonl` line by line in chunks of 500 matching events, opens only that file and writes nothing, so a corrupt `promotions.json` is left alone, and a malformed line is skipped, counted and warned about on stderr; `--rest` pages `GET /lineage`, each request limited by `--timeout-ms`, default 30000), and `--out` is written to `<out>.tmp` and renamed into place, and writes a fixed-header CSV for metering (lines end in LF; a tenant starting with `=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet does not read it as a formula). A missing `--data-dir`, both or neither of `--data-dir` / `--rest`, an empty `--tenant` (which would read as no filter), and a `--tenant` that disagrees with the `x-kohaku-tenant` header exit 2 instead of exporting nothing or the wrong thing; the `tenant` option of `summarizeUsage` / `summarizeLineage` (and the Python mirror) now reads `""` as no filter, like a StoragePort, and a compose through an MCP host, which resolves no tenant, lands in the row whose tenant is empty; `evidence export` shares the same helpers, so its tenant / header mismatch now also exits 2. The host's in-process daily token ledger is not used for metering.
- Updated dependencies [[`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`5bb982e`](https://github.com/yosuque/kohaku/commit/5bb982e2fca7d4c609d5b99b6dc71bac95dbfe55), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc)]:
  - @kohaku-ui/spec-core@0.4.1
  - @kohaku-ui/data-binding@0.4.1

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

- Updated dependencies [[`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/data-binding@0.4.0

## 0.3.0

### Minor Changes

- [#32](https://github.com/yosuque/kohaku/pull/32) [`9e227c9`](https://github.com/yosuque/kohaku/commit/9e227c9dd2ceda6b9c2483296be4b4dc0e090bfd) Thanks [@yosuque](https://github.com/yosuque)! - Promotion judge / rubric / acknowledgement / extraction-budget fixes.
  
  - **Judge fidelity ([#1](https://github.com/yosuque/kohaku/issues/1)):** `approve()`'s own draft argument is now forwarded to the configured judge as additive context (`PromotionJudgeContext.draft`; `PromotionJudge`'s existing 2nd-argument signature stays additively compatible). `@kohaku-ui/evals`' `JudgeInput` gains an optional `draft`, and the `suggestion_fidelity` criterion (renamed "schema fidelity" in its prompt text; the `id` is unchanged, since it is persisted in `component.judged` verdicts) verifies `draft` — the schema actually being registered — against the HTML, showing a supplied `suggestion` as context only.
  - **Rubric variant per call ([#14](https://github.com/yosuque/kohaku/issues/14)):** `judge()` now records `JudgeVerdict.rubricVariant` (`"full"` | `"no-schema"`). When neither `draft` nor `suggestion` is known, `suggestion_fidelity` is dropped and the remaining criteria are scored under exactly `l2PromotionRubricV0_3`'s own weights (rather than auto-scoring the criterion 1, which previously inflated the score by up to +0.10 for such callers — see the `promotion-schema-suggestion` changeset's updated note). `l2PromotionRubric` itself stays version `"0.4"`, and so does the persisted `JudgeVerdict.rubricVersion` in this dropped-criterion case: `rubricVersion` always names the configured rubric (the built-in default or a custom rubric's own version), never `l2PromotionRubricV0_3`'s `"0.3"` — only `rubricVariant` records that the schema criterion was dropped.
  - **Acknowledgement on the wire ([#9](https://github.com/yosuque/kohaku/issues/9)):** `POST /promotions/:artifactId/approve` accepts an optional `acknowledgedSuggestion` boolean; `Promotions.approve` (`@kohaku-ui/lineage`) and `PromotionsClient.approve` (`@kohaku-ui/client`) thread it through. It is recorded on `component.schemaEdited` as `acknowledged` (a missing value is recorded as `false`) but never enforced. `summarizeLineage`'s `review.acceptedAsIs` now requires `acknowledged === true` in addition to an empty `changed`.
  - **Extraction budget ([#15](https://github.com/yosuque/kohaku/issues/15)):** `createSchemaExtractor({ llm, timeoutMs = 20000 })` passes `abort: AbortSignal.timeout(timeoutMs)` to `generateObject` (`LlmPort.generateObject` already accepted `abort`; no `@kohaku-ui/llm` change was needed). `createPromotions({ ..., suggestConcurrency = 4 })` runs `suggestSchema` over a scan's freshly nominated candidates with at most `suggestConcurrency` in flight at once (a small worker pool, `mapWithConcurrency`, no new dependency) instead of an unbounded `Promise.all`.
  - **`summarizeLineage`'s `review` pairing** now stably sorts its input by `ts` (ties broken by original array position) before pairing nominations with reviews, so a caller no longer needs to guarantee ascending `ts` order itself.

- [#29](https://github.com/yosuque/kohaku/pull/29) [`cd12831`](https://github.com/yosuque/kohaku/commit/cd12831667055a0d7aec31453dcc6a7e3448e47c) Thanks [@yosuque](https://github.com/yosuque)! - LLM auto-extraction of the promotion schema (advisory). `createPromotions` gains a `suggestSchema` hook, called fail-open at auto-nomination; `@kohaku-ui/evals` ships the reference extractor (`createSchemaExtractor`, stamped `l2-schema-extraction@0.1`) next to the judge, whose L2 rubric is now 0.4 with a `suggestion_fidelity` criterion. The proposal is persisted on the candidate, exposed as an additive optional `suggestion` on the candidate JSON, audited as `component.schemaSuggested`, and the reviewer's edits are audited as `component.schemaEdited`. `summarizeLineage` adds `review` (nominated → reviewed turnaround, zero-edit acceptances) and `promotions.schemaSuggested / schemaEdited`. `@kohaku-ui/admin-react`'s Promotions tab prefills from the proposal, shows a per-field diff and requires an acknowledgement before approving.
  
  **Note for consumers who never supply a schema (no `draft`/`suggestion` passed to `judge()`):** the default gate is unchanged. A later fix (see the `@kohaku-ui/evals` / `@kohaku-ui/lineage` changesets for the judge-fidelity / rubric-variant follow-up) made `judge()` drop `suggestion_fidelity` entirely (rather than auto-scoring it 1) and score the remaining criteria under exactly `l2PromotionRubricV0_3`'s own weights whenever neither a `draft` nor a `suggestion` is known, so a no-schema consumer no longer sees the +0.10 inflation this note originally warned about. Pinning `l2PromotionRubricV0_3` explicitly remains available but is no longer necessary for that reason. **`rubricVersion` in the persisted verdict always names the configured rubric** (`"0.4"` for the built-in default, even in this dropped-criterion case) — `rubricVariant: "no-schema"` is what records that `suggestion_fidelity` was dropped, not a version change.

### Patch Changes

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
  - @kohaku-ui/data-binding@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/data-binding@0.2.0

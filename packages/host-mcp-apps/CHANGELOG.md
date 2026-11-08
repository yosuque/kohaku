# @kohaku-ui/host-mcp-apps

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

- [#134](https://github.com/yosuque/kohaku/pull/134) [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee) Thanks [@yosuque](https://github.com/yosuque)! - domain-mcp: an unsigned `_limit` can no longer widen a read, and a write whose upstream call timed out is reported as "outcome unknown".
  
  - `@kohaku-ui/domain-mcp`: `_limit` is outside the capability's signed ref and may only lower the signed `limit`, but a negative, zero or fractional value was forwarded as `Math.min(-1, signed)`, i.e. `-1`; an upstream that does `rows[:limit]` then returned more rows than the signed ref authorised. `coerceToolArguments` now requires `_limit` to be a positive safe integer (`"5.0"` and `"1e1"` stay accepted) and otherwise throws `McpArgumentError` (`argument "_limit": expected a positive integer`, still 404 `REF_NOT_FOUND` over REST). A write's `McpTimeoutError` now carries `code: "MCP_OUTCOME_UNKNOWN"` (exported as `MCP_OUTCOME_UNKNOWN`); a read's has no code.
  - `@kohaku-ui/host-core`: new `OUTCOME_UNKNOWN_MESSAGE` and `isOutcomeUnknownError` (an Error whose `code` is or ends in `OUTCOME_UNKNOWN`); `classifyHostError` gains the `outcomeUnknown` kind (before the `typed` rule, so the error's own text, which names the upstream tool, is never shown) and `clientMessageFor` returns the fixed message for it.
  - `@kohaku-ui/host-rest`: `POST /binding/action` answers such a write with **503 `INTERNAL`** and the fixed message `the action's outcome is unknown; verify before retrying` instead of 404 `REF_NOT_FOUND`, so the caller verifies before sending the same approval again (a stateless approval token would run the write twice). No new wire error code; the real error still reaches `onError`. Every other failed write stays 404.
  - `@kohaku-ui/host-mcp-apps`: `kohaku_action` returns the same fixed message as its tool error (it came out as the generic internal-error text before).
  - Python port: the same changes in `kohaku.domain_mcp`, `kohaku.host_core`, `kohaku.host_rest` and `kohaku.host_mcp`.
  - Fix round: `_limit` and the signed `limit` must both be positive safe integers (a signed `0` / `-1` used to slip under `maxLimit`); a write's deadline is now always an `McpTimeoutError` even when the client rejects synchronously on abort; any other write failure that does not say the tool did not run (closed connection, failed send, transport error, the SDK's own timeout) is wrapped in the new `McpOutcomeUnknownError` (same code, original as `cause`), while a JSON-RPC error the server answered and a local pre-send error are re-thrown unchanged. Because of this wrapper an SDK message such as "Connection closed" no longer reaches the model over MCP.
  - Minor for host-core / host-rest / host-mcp-apps: the `HostErrorClass` union widens (`outcomeUnknown`) and `POST /binding/action` answers 503 instead of 404 for such a write. SPEC gains ACT-OUT-001 [Draft, SHOULD]: the fixed message is the normative discriminator, no new wire field or `HostErrorCode`, and a client must not retry `/binding/action` on a 503 (pinned for `@kohaku-ui/data-binding`'s `invokeAction` by a test).
  - `@kohaku-ui/spec-core`: the DomainPort doc now states the `*_OUTCOME_UNKNOWN` error-code convention host-core relies on. `@kohaku-ui/data-binding`: a comment on the no-retry guarantee only.

- [#124](https://github.com/yosuque/kohaku/pull/124) [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f) Thanks [@yosuque](https://github.com/yosuque)! - The data-plane read path no longer executes a governed Action (SPEC ACT-RD-001, [Draft], SHOULD). `GET /binding/resolve`, the MCP `${prefix}_resolve_binding` tool and the MCP initial-data pre-resolution now look the operation a `query://` ref names up in the memoized operation index before `DomainPort.invoke`, and refuse one whose declared `tier` is `"confirm"` or `"approve"`. Before, a read capability for such a ref ran the operation with no confirmation, no approval and no audit, because the read path never passed through the action gate; only the assumption that an Intent never builds such a ref prevented it.
  
  - `host-core`: new `isGatedOperation(entry)` (a type guard), `createGatedReadGuard(input)`, `runGatedReadGuard(input)` and `GATED_READ_MESSAGE`. The guard returns `readable` / `gated` / `schemaInvalid` / `indexUnavailable` for the host to map onto its own wire, and audits the refusal fail-open as `action.denied` (reason `gated operation is not readable`, the operation's tier). One guard reads the operation index once, so a pre-resolution over a dead `listOperations()` reports and audits once.
  - `host-rest`: `/binding/resolve` answers `403 CAPABILITY_DENIED` (`gated operation is not readable`) for a gated operation, and `500 INTERNAL` for a non-gated operation whose `paramsSchema` is invalid (as the action path). Behaviour change: when `DomainPort.listOperations()` cannot be read, the route now fails closed with `503 INTERNAL` (`action gate unavailable`); it used to consult no index at all. The guard runs after the capability verified and the rate limit was taken.
  - `host-mcp-apps`: `${prefix}_resolve_binding` returns a tool error (`capability denied: gated operation is not readable`, or `operation index unavailable`). The initial-data pre-resolution skips a gated ref (and an unreadable index skips every ref, reported to `onError`); a snapshot (`render_snapshot`, or the `legacyUiResource` co-emission) of a Spec that binds data to a refused operation fails with `SNAPSHOT_REF_NOT_READABLE`, whose message names the cause, and does not audit the refusal a second time.
  - Tier-less operations, tier `"auto"` and operations `listOperations()` does not list stay readable, so a host that declares no gated operations is unaffected. The Python port (`kohaku.host_core`, `host_rest`, `host_mcp`) has the same behaviour.
  - `spec-core`: the `DomainPort` JSDoc (and the Python Protocol docstring) now states two invariants the guard relies on: `invoke` dispatches on the exact operation name, and every operation with side effects is listed with its tier. Documentation only.
  - `@kohaku-ui/domain-mcp`: documented that `tierFor(tool) === "auto"` on a write tool makes it reachable through a read ref (see its README).

- [#128](https://github.com/yosuque/kohaku/pull/128) [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85) Thanks [@yosuque](https://github.com/yosuque)! - Filters on generated screens: `ComposePolicy.l1Filters` (default `false`, design.md [#78](https://github.com/yosuque/kohaku/issues/78)) makes the composer inject the Intent's filters into an L1-generated Spec deterministically, so changing a filter re-resolves the data with no recompose and no model call. The model decides nothing about the filter set or its value domain.
  
  - `@kohaku-ui/spec`: SPEC change-list item 22 and §6.1.1 (the last `event: patch` MAY carry `capability` and `actions`).
  - `@kohaku-ui/spec-core`: `FilterDescriptor` (`{ param, queryParam, paths, label, options }`) and the optional `SemanticPort.describeFilters?(intent, { tenant?, locale? })`.
  - `@kohaku-ui/intents`: `IntentDef.filters?(locale?)`, derived from `defineIntent`'s `facets` + `queries[].paramMap` for every discrete, string-valued `select` facet (numeric facets, `control: "number"`, an ambiguous `paramMap`, callback `queries`, and a `queryParam` that is also a `fixedParams` key or is shared by another Intent param on the same path are skipped). `paths` lists the template paths that map the param.
  - `@kohaku-ui/semantic-llm`: `createLlmSemanticPort` implements `describeFilters` from the catalog.
  - `@kohaku-ui/composer`: `injectFilters` (a post-step of L1 generation only, after `normalizeIds`): adds `control.select` + `state` + `state.set` event + `data.bind`, binding only the data components that read a path the descriptor governs. It falls back to the Spec as generated (never worse than not injecting) when the bind variants exceed `ComposePolicy.l1FiltersMaxVariants` (default 64: a 256-scope capability exceeds Node's 16 KiB header limit), the root is not a `layout.stack` / `layout.grid`, or the result fails `validateSpecStructure`. `ComposeTrace.filters` records `{ injected, skipped? }`. `l1Filters` joins `policyFingerprint` only when `true` (an absent key, so existing cache keys are unchanged), together with a hash of the descriptors actually used (`filterDescriptorsHash`: labels, options, paths) and the cap when not 64, so another `session.locale` (now passed to `describeFilters`, so labels follow the session language) or a tenant-specific option list is cached separately; the prompt is unchanged. `ResolvedRefs.descriptors?`, `postProcess(..., filters?)`, `postAndValidate(..., filters?)` and `composeStream`'s patch event `converged?: true` are additive. A selected filter value cannot be cleared back to "all" (no empty bind value, like the L0 cross-filter).
  - `@kohaku-ui/host-rest`: on `/compose/stream` the last convergence patch carries a replacement `capability` (issued from the finalized Spec like `/compose`'s, so it also carries the Spec's write scopes) and the Spec's `actions` manifest (`{ patch, capability?, actions? }`, SPEC §6.1.1), only when it declares `data.bind`; every other stream is byte-identical to before.
  - `@kohaku-ui/client`, `@kohaku-ui/renderer-react`: the `patch` stream event exposes the optional `capability` (and, in the client SDK, `actions`); `useSpecStream` replaces its capability with it.
  - `@kohaku-ui/host-mcp-apps` **(behaviour change independent of `l1Filters`)**: `preresolveInitialData` resolves every initial ref but at most 32 distinct non-initial bind variants eagerly, for any Spec (previously all of them, up to 256); the rest resolve on demand through `kohaku_resolve_binding`. `snapshotHtmlFor` still resolves the full set it needs.
  - Python port (`kohaku-ui` on PyPI): the same, in `kohaku.spec` (`FilterDescriptor`), `kohaku.intents`, `kohaku.semantic_llm`, `kohaku.composer` (`inject_filters`, `ComposePolicy(l1Filters=True, l1FiltersMaxVariants=...)`), `kohaku.host_rest` and `kohaku.host_mcp`; `injectFilters`, the descriptor hash and the `policy_fingerprint` bytes are pinned against TS by the cross-language golden.

- [#127](https://github.com/yosuque/kohaku/pull/127) [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a) Thanks [@yosuque](https://github.com/yosuque)! - `StoragePort` gains an optional **compare-and-set**, so several host instances sharing one redis / postgres no longer silently lose each other's promotion-state and fixation updates (SPEC Appendix 12, REST-CONF-001 [Draft], design.md [#79](https://github.com/yosuque/kohaku/issues/79)).
  
  - **spec-core**: `PromotionState.revision?` (also in `PromotionStateSchema` / `spec/schemas`), `StoragePort.supportsCompareAndSet?: true`, a four-state `expectedRevision` option on `putPromotionState`, `putFixation` and `deleteFixation` (omitted = unconditional, `null` = must not exist, `""` = must exist and carry no `revision`, any other string = must equal), the new `StorageConflictError` (`code: "STORAGE_CONFLICT"`) a mismatch throws without writing, and the `CONFLICT` `HostErrorCode`, plus the `singleProcess` marker. Adapters that do not declare the extension may keep ignoring the option, so existing adapters and fake ports stay valid. The batch `putPromotionStates` stays unconditional, so on a port that declares the extension the lineage service writes bulk nominations one candidate at a time, conditional on the revision the scan loaded, and skips a candidate that lost the race (no `component.nominated` for it) instead of rolling back an approve another instance recorded.
  - **storage-memory / storage-redis / storage-postgres**: memory, redis and postgres declare it. The file port honors `expectedRevision` (against the snapshot re-read inside its in-process lock) but does **not** declare `supportsCompareAndSet` — its lock does not span processes, so two processes sharing a data directory can still lose updates — and both it and memory mark themselves `singleProcess: true`. redis uses `WATCH` / `MULTI` / `EXEC` (no Lua) on a dedicated connection it opens lazily from the shared client (offline queue and auto-resend off; a reconnect between WATCH and EXEC is refused as a conflict; close() closes it, even for an injected client; the ACL needs `WATCH` / `UNWATCH`); postgres uses one conditional `UPDATE` / `INSERT ... ON CONFLICT DO NOTHING` / `DELETE` on the payload's JSON `revision` (SQLSTATE `40001` also maps to the conflict), with no schema change. `@kohaku-ui/port-contracts` gets an opt-in `requireCompareAndSet` case group.
  - **lineage**: every promotion snapshot write now carries a fresh `revision` and is conditional on the one the candidate was loaded with; `act()` re-reads the stored revision right before recording its audit event and throws `StorageConflictError` if it moved. Fixation `unfixate` / `invalidate` / `refreshFingerprint` / `replace` pass the revision they read (`fixate` stays an unconditional human overwrite). The persisted promotion state now has a `revision` key.
  - **host-core / host-rest / host-mcp-apps**: `StorageConflictError` is answered with `409 CONFLICT` (REST also reports it to `onError` under `storage.conflict`; the self-heal `invalidate` / `refreshFingerprint` treat a lost race as a silent no-op) and the fixed message `the resource was modified concurrently; reload and retry` (`STORAGE_CONFLICT_MESSAGE`; a new `conflict` kind of `classifyHostError`), never retried inside the host; MCP returns the same message as a tool error; `applyCatalogMigration` reports a lost race as a skipped step.
  - **host**: `createKohakuHost` warns once when a custom `storage` declares neither `supportsCompareAndSet` nor `singleProcess`.
  - **Upgrade note**: a record written before revisions existed is unversioned and is guarded too (a writer that read it expects `""`, "present, no revision"); an old-version writer can still overwrite unconditionally, so upgrade every writer before relying on the extension. A recorded `component.reviewed` approve whose state write lost the race was not applied.
  - Python port (`kohaku-ui` on PyPI): the same, with `UNSET` meaning "no expectation" (and `""` the unversioned-record state) and keyword-only `expected_revision` parameters on the `StoragePort` Protocol methods (a custom Python port with the old signatures now fails type checking; at runtime it keeps working).

### Patch Changes

- [#131](https://github.com/yosuque/kohaku/pull/131) [`2e2cc38`](https://github.com/yosuque/kohaku/commit/2e2cc38451e56bd569e7d8f885bf04ba873b95b7) Thanks [@yosuque](https://github.com/yosuque)! - Two MCP profile fixes (Python mirrored in the same change):
  
  - MCP Tasks owner binding no longer uses the rate-limit key first. The owner is now the resolved principal's id when `resolvePrincipal` is wired, else `rateLimitKey`, else the session id, else `"anonymous"` (a `resolvePrincipal` that resolves the default principal's id, as for a guest, falls through to `rateLimitKey`, so guests do not collapse into one owner), so two authenticated principals behind one NAT that share an IP-based `rateLimitKey` can no longer `tasks/get` (reading the result's bearer capability) or `tasks/cancel` each other's tasks.
  - `${prefix}_action` and `${prefix}_resolve_binding` now take the rate limit after the capability verified and pass the capability's signed tenant to `rateLimiter.take` and `onRateLimited` (SPEC CAP-TEN-002), so a `tenants.<id>.rateLimits` rule applies over MCP. The principal component of the key is unchanged and `compose` stays checked as before. Behaviour change: a request whose capability fails verification no longer consumes or hits the limiter.

- [#120](https://github.com/yosuque/kohaku/pull/120) [`8a7ae32`](https://github.com/yosuque/kohaku/commit/8a7ae3289494017a47d400974140e1bfa809f795) Thanks [@yosuque](https://github.com/yosuque)! - Security: MCP Tasks (`tasksEnabled: true` only; the default is off) are now bound to the caller that created them. Previously anyone who learned a task id could `tasks/get` it, and a completed task's `result` carries the bearer write capability in `_meta`, so a leaked id leaked a write token; `tasks/cancel` could likewise abort someone else's compose. `TaskStore.create` now takes an `owner` (breaking for a direct `createTaskStore` caller: `get(taskId, owner)`, `requestCancel(taskId, owner)`), derived from the key the rate limiter uses (`rateLimitKey`, else the resolved principal's id, else the session id, else `"anonymous"`), and a mismatching owner gets exactly the unknown-task answer (InvalidParams). Wire `resolvePrincipal` or `rateLimitKey` for a per-caller binding; without either, callers that share a connection (everyone, on stateless HTTP and stdio) share an owner. Also: a still-working task whose TTL elapses is now aborted when it is purged, and the task id echoed in the unknown-task error is capped at 128 characters. The Python port (`kohaku.host_mcp`, PyPI) has the same fix.

- [#120](https://github.com/yosuque/kohaku/pull/120) [`b9261af`](https://github.com/yosuque/kohaku/commit/b9261af8790bd7cb184ba846f1c6324037c66947) Thanks [@yosuque](https://github.com/yosuque)! - Python port (`kohaku-ui` on PyPI): `kohaku.host_mcp` now implements the MCP Tasks extension (`io.modelcontextprotocol/tasks`, 2026-07-28), mirroring `host-mcp-apps`. `AttachOptions.tasks_enabled` (default `False`) makes `kohaku_compose` and the intent tools task-capable for a request that declares the extension in its `_meta`: such a request gets a `CreateTaskResult` (`resultType: "task"`, `ttlMs` 600 000, `pollIntervalMs` 2 000) and polls `tasks/get` or cancels with `tasks/cancel` (which aborts the in-flight compose). With the default the server neither declares the extension nor registers `tasks/*`, and every tool stays synchronous. The TypeScript `@kohaku-ui/host-mcp-apps` is unchanged: it carries no code change in this entry and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.
- Updated dependencies [[`8274641`](https://github.com/yosuque/kohaku/commit/82746415eb6e7188590d6523fab94e1d41b167fe), [`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2), [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee), [`05f2c6d`](https://github.com/yosuque/kohaku/commit/05f2c6d6f51a86e237a285a8e83e353571733a92), [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f), [`4e28451`](https://github.com/yosuque/kohaku/commit/4e284512c2db9a0e2ac0bd8ab118689fbebe5c10), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85), [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d), [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a)]:
  - @kohaku-ui/host-core@0.6.0
  - @kohaku-ui/spec-core@0.6.0
  - @kohaku-ui/data-binding@0.6.0
  - @kohaku-ui/composer@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

### Patch Changes

- [#85](https://github.com/yosuque/kohaku/pull/85) [`b06ee97`](https://github.com/yosuque/kohaku/commit/b06ee972794cb1c64dba2a23114791c13f9de9f6) Thanks [@yosuque](https://github.com/yosuque)! - Raise the MCP TypeScript SDK floor to the 2.3 line: `@modelcontextprotocol/server` / `client` / `core` `^2.3.1` (were `^2.0.0`), `@modelcontextprotocol/node` `^2.1.1`, `@modelcontextprotocol/ext-apps` `^2.0.3`. The peer ranges of `@kohaku-ui/host-mcp-apps` (`server`), `@kohaku-ui/host` (`server`, `node`) and `@kohaku-ui/mcp-renderer` (`ext-apps`) follow, and `kohaku init --mcp` now generates projects that depend on `@modelcontextprotocol/server` `^2.3.1` and `@modelcontextprotocol/node` `^2.1.1`. No source change was needed for the types.
  
  Observed behavior change of the Tasks extension (`io.modelcontextprotocol/tasks`) under SDK 2.3 (the published 0.4.0 declares `^2.0.0`, so its users already resolve SDK 2.3.x):
  
  - SDK 2.0.0 rejected `tasks/get` / `tasks/cancel` with `-32601` before kohaku's handlers ran. Since SDK 2.3.0 (SEP-2663) the SDK lets those two names through when a schema-explicit handler is registered, which kohaku does, so they are now reachable. The SDK also requires `Mcp-Name: <taskId>` on them (SDK clients send it); a request without it is rejected with `-32020` before dispatch.
  - `AttachOptions.tasksEnabled` unset (the default, unchanged): no behavior change. The extension is neither declared nor registered, `tasks/get` / `tasks/cancel` still answer `-32601`, and the compose family stays synchronous.
  - `AttachOptions.tasksEnabled: true`: `tasks/get` and `tasks/cancel` went from unreachable to working. A task-backed `kohaku_compose` can now be polled to `completed` and cancelled over the wire.
  
  The `host-mcp-apps` tripwire tests were updated accordingly, and cancellation is now tested through a real `tasks/cancel`. The default of `tasksEnabled` is a separate product decision and is left unchanged.

- [#81](https://github.com/yosuque/kohaku/pull/81) [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d) Thanks [@yosuque](https://github.com/yosuque)! - Structural refactoring, round two (behavior-preserving):
  
  - `@kohaku-ui/host/mcp-http` (new subpath): `createMcpHttpServer`, the Streamable-HTTP scaffold (Host/Origin guards, echoed-Origin CORS, OPTIONS preflight, size-capped body pre-read, stateless `createMcpHandler` wiring) that `apps/sample-mcp` used to carry inline. `@modelcontextprotocol/node` becomes an optional peer dependency, needed only for this subpath. Defaults follow the server `kohaku init --mcp` generates; every place the sample answers differently is an explicit option. The init template itself still carries its own copy and switches after this release.
  - `@kohaku-ui/host-core`: `buildActionManifestSafely` and `recordComposedAndFallback`, the order-neutral delivery helpers both host profiles now call (each host keeps its own step order and `onError` endpoint names; characterization tests pin them).
  - `@kohaku-ui/spec-core`: `src/ports.ts` is now a barrel over one file per Port under `src/ports/` (plus `theme-tokens.ts`); every exported name and import path is unchanged.
  - `@kohaku-ui/host-rest`: the compose pipeline helpers (capability issuance, fixation host) live in `routes/compose-pipeline.ts`.
  - `@kohaku-ui/cli`: one registration module per command under `cli/src/cli/`, result printers next to their runners as `format*` functions; `--help` output and exit codes are unchanged (pinned by a help snapshot test).

- [#89](https://github.com/yosuque/kohaku/pull/89) [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e) Thanks [@yosuque](https://github.com/yosuque)! - Behavior-preserving structural refactoring round (third pass). No wire shape, message, status code, prompt byte, cache key, lineage payload or generated-project byte changes; every step is pinned by existing tests plus new characterization tests.
  
  - `host-core`: new `resolveGuiDelta` (the GUI-delta intent resolution both hosts ran inline) and `runActionGate` (the governed-action gate sequence — operation index → declared entry → schema → unsafe keys → `ActionGate.check` → audit — that REST `/binding/action` and MCP `kohaku_action` maintained twice; each host keeps only its wire mapping and `onError` endpoint names). Both hosts' gate sequences are pinned by new `action-gate-sequence` characterization tests.
  - `host-mcp-apps`: `composeAndPackage` is now sequential steps (`composeForDelivery` → `packageComposed`) instead of a callback that smuggled the capability and manifest out; a local `authorizeCapability` for the app-only tools.
  - `host-rest`: a local `authorizeCapability` in the binding routes.
  - `renderer-core`: new `describeSpreadsheetFooter` descriptor (with `SpreadsheetFooterDescriptor`), the single source of the spreadsheet footer decision now shared by `renderer-react` and `renderer-wc`.
  - `composer`: the policy-fingerprint machinery moved to its own module (`policy-fingerprint.ts`, same exported names); the L0 fixed-Spec short-circuit now runs through the same assemble → store → trace tail as L1/L2 (pinned by an L0/L1 characterization test); smaller extractions in `tier-ladder.ts` and `tiers/l2-generate.ts`; a contract test that the design-kit namespaces match the utility prefixes.
  - `evals`: `createJudge`'s prompt builders are all module-level now (`buildL1JudgePrompt`, `rubricSystem`).
  - `lineage`: `reconcile` lives in `promotion/reconcile.ts` (`createReconciler`) with the projection argument builders in `promotion/projection.ts`; `approve()`'s judge stage is no longer duplicated; the repeated anonymous promotion types are named (`CreatePromotionsOptions` is now exported); `toProposals` / `durationStats` / `usageRowKey` extracted.
  - `cli`: `commands.ts` split into one runner module per command (`conformance`, `explain`, `smoke-l2`, `component`, `dataset`, `scaffold`) so each action loads only its own runner; the `--mcp` addon of `kohaku init` lives in `init/mcp-addon.ts`; `EXTERNAL_VERSIONS` is typed by key; the generated project is pinned byte for byte by goldens under `cli/test/init/__golden__` (regenerate with `KOHAKU_UPDATE_INIT_GOLDEN=1`).
  
  Second pass of the same round (the four items deferred from the first pass):
  
  - `host-core`: new `createFixationDeliveryHost` / `FixationDeliveryHostWiring` / `withFixationLock` — the `FixationDeliveryHost` adapter both hosts built by hand, now built once in host-core over a keyed mutex the host owns (`${tenant ?? ""} ${intentHash}` is the one lock-key rule). The mutex lifetime stays each host's choice: host-rest creates one per `createKohakuRoutes` app; host-mcp-apps keeps one per `McpHostDeps` object (unchanged). Pinned by new `fixation-lock` characterization tests in both hosts (self-heal and the management plane's fixate serialize on the same key; different keys do not).
  - `host-rest`: the four module-level per-deps `WeakMap` memos (operation index, action gate, fixation mutex, fixation host) are fields of `RouteContext`, built once per `createKohakuRoutes` call. Observable only when the same `deps` object is mounted twice: each app now reads `listOperations()` once and owns its own fixation lock, where the memos used to be shared across apps (a contract test pins the per-instance scope). `createActionGate` / `createOperationIndex` run at app creation instead of at the first request (both are pure constructions; `listOperations()` is still awaited lazily).
  - `composer`: `ComposePolicy` is declared as six exported concern slices (`ComposeCachePolicy`, `ComposeTierPolicy`, `ComposeGenerationPolicy`, `ComposeL1Policy`, `ComposeL2Policy`, `ComposeAssemblePolicy`) merged by interface extension; the field set, every default and the fingerprint are unchanged (a two-way type contract test pins the 17 fields). The cache-failure helpers and `provenanceStampsOf` take only their slice.
  - `cli`: the unreferenced `scaffoldPorts` / `scaffoldGolden` wrappers are gone (the `scaffold` command already called `writeScaffold` directly; the tests now do too).
  - `spec-core`: doc comment only (`createKeyedMutex` names the current fixation-lock call sites).

- [#80](https://github.com/yosuque/kohaku/pull/80) [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141) Thanks [@yosuque](https://github.com/yosuque)! - Internal, behavior-preserving refactoring of the composer tier ladder (budget gate, discriminated `TierResult`, L2 lint rule table), the evals judge (pure verdict aggregation), lineage (promotion import cycle, fixation guard/stamp helpers, candidate bulk loader, analytics accumulators), the CLI (shared lineage-source options, scaffold target table), both hosts (compose pipeline module, shared tool-call preamble, inline gate mapping) and the Postgres/Redis adapters (shared WHERE builder and record-table helper). No public API, wire format, persisted format or client-visible message changes.

- [#88](https://github.com/yosuque/kohaku/pull/88) [`2a0bcd6`](https://github.com/yosuque/kohaku/commit/2a0bcd6eb50b5317c79c2e59345f52487b7ca6e6) Thanks [@yosuque](https://github.com/yosuque)! - Review-driven fixes across the host, lineage, storage and CLI packages:
  
  - `@kohaku-ui/host-mcp-apps`: an Action gate that cannot decide (the operation index failing to build, or `ActionGate.check` / `ApprovalPort.verifyApproval` throwing) is now audited as an `action.denied` lineage event through host-core's `recordActionGateUnavailableDenial`, as the REST profile already did, and the tool error carries the fixed `action gate unavailable` message.
  - `@kohaku-ui/host-core`: the console error reporter's non-debug line now names the error type and, when present, its `code` / provider / model (`LlmError[PROVIDER anthropic/...]: ...`) so an operator can tell a provider outage from any other failure; the cause chain and stack stay debug-only.
  - `@kohaku-ui/lineage`: fixation proposals skip `view.composed` records that carry `provenance.fallback` (a fallback Spec can never be fixated, so it no longer shows up as a 100%-stable candidate); the generic promotion `act()` path keeps "audit record first, snapshot second" and now documents why (a lost `component.reviewed` must never let a retried approve() publish without the human-approval evidence); re-approving a published candidate whose draft or html is missing now fails fast instead of passing `undefined` to the projection.
  - `@kohaku-ui/storage-postgres`: the migration advisory-lock wait is bounded (`MIGRATION_LOCK_WAIT_MS`, 60 s) and rejects with the lock key instead of hanging `ready()` forever; the README documents that Spec-cache rows stored without `ttlSeconds` are never swept.
  - `@kohaku-ui/storage-memory`: `listLineage` scans from the tail and stops after `limit` matches instead of filtering the whole log.
  - `@kohaku-ui/semantic-llm`: an empty intent catalog now fails with "the intent catalog is empty" rather than "does not match any intent".
  - `@kohaku-ui/cli`: the `kohaku init` REST server drains gracefully on SIGINT / SIGTERM (`/api/health` turns 503 while shutting down, `KOHAKU_SHUTDOWN_GRACE_MS` bounds the drain, a `start` script is generated), the `init --mcp` server validates `KOHAKU_SHUTDOWN_GRACE_MS`, the `scaffold ports` hints mention the capability secret and the full install line, and the package README lists every command.
- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e), [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141), [`2a0bcd6`](https://github.com/yosuque/kohaku/commit/2a0bcd6eb50b5317c79c2e59345f52487b7ca6e6)]:
  - @kohaku-ui/composer@0.5.0
  - @kohaku-ui/data-binding@0.5.0
  - @kohaku-ui/host-core@0.5.0
  - @kohaku-ui/spec-core@0.5.0

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

# @kohaku-ui/host-rest

## 0.4.0

### Minor Changes

- [#46](https://github.com/yosuque/kohaku/pull/46) [`5a07b1a`](https://github.com/yosuque/kohaku/commit/5a07b1adbcb1545bbc35df0c6df9ed54a22fcf29) Thanks [@yosuque](https://github.com/yosuque)! - Closes a validation gap for a directly-specified Intent (`kind: "intent"`): unlike NL/GUI input, it never
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

- [#47](https://github.com/yosuque/kohaku/pull/47) [`36392f0`](https://github.com/yosuque/kohaku/commit/36392f05d3e4fa8426e6e6ab24c50081cc057595) Thanks [@yosuque](https://github.com/yosuque)! - Add `LineageFilter.correlationId` (payload equality) and forward (append-order) paging over the lineage
  log, exposed as the optional `StoragePort.pageLineage` method (implemented by all four reference storage
  adapters), `GET /lineage?order=asc&cursor=&pageSize=` on the REST profile, and `KohakuClient.lineagePages()`
  on the client SDK. Both additions are backward compatible: a request that omits the new query parameters,
  and a `StoragePort` that does not implement `pageLineage`, behave exactly as before.

- [#52](https://github.com/yosuque/kohaku/pull/52) [`cb0129e`](https://github.com/yosuque/kohaku/commit/cb0129e1ab7085ece6208169d206c5fc271c6d15) Thanks [@yosuque](https://github.com/yosuque)! - Replace `node:crypto`'s `randomUUID` with `globalThis.crypto.randomUUID()` in the request-id and
  self-heal-error fallback paths (`routes/compose.ts`, `routes/shared.ts`). Both are the exact same
  RFC 4122 v4 UUID generator — Node >= 19 and every evergreen browser expose it as `globalThis.crypto`
  — so this removes host-rest's only Node-only import with no behavior change, in support of running a
  host-rest-based host (e.g. the static playground, `@kohaku-ui-sample/playground`) entirely in a browser.

### Patch Changes

- [#53](https://github.com/yosuque/kohaku/pull/53) [`8df82f6`](https://github.com/yosuque/kohaku/commit/8df82f661b601ac986049302d888ee058bcde27d) Thanks [@yosuque](https://github.com/yosuque)! - Hardens JSON input validation against pathologically deep nesting. `JsonObjectSchema` and `JsonValueSchema`
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
- Updated dependencies [[`3d523bf`](https://github.com/yosuque/kohaku/commit/3d523bf339ff7d114feea684dfcbc9c161a5f039), [`5a07b1a`](https://github.com/yosuque/kohaku/commit/5a07b1adbcb1545bbc35df0c6df9ed54a22fcf29), [`8df82f6`](https://github.com/yosuque/kohaku/commit/8df82f661b601ac986049302d888ee058bcde27d), [`36392f0`](https://github.com/yosuque/kohaku/commit/36392f05d3e4fa8426e6e6ab24c50081cc057595), [`e9f7d34`](https://github.com/yosuque/kohaku/commit/e9f7d34b62c169b2e56af970f68ade6d2ff1b31c)]:
  - @kohaku-ui/composer@0.4.0
  - @kohaku-ui/host-core@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/data-binding@0.4.0
  - @kohaku-ui/registry@0.4.0

## 0.3.0

### Minor Changes

- [#32](https://github.com/yosuque/kohaku/pull/32) [`9e227c9`](https://github.com/yosuque/kohaku/commit/9e227c9dd2ceda6b9c2483296be4b4dc0e090bfd) Thanks [@yosuque](https://github.com/yosuque)! - Promotion judge / rubric / acknowledgement / extraction-budget fixes.
  
  - **Judge fidelity ([#1](https://github.com/yosuque/kohaku/issues/1)):** `approve()`'s own draft argument is now forwarded to the configured judge as additive context (`PromotionJudgeContext.draft`; `PromotionJudge`'s existing 2nd-argument signature stays additively compatible). `@kohaku-ui/evals`' `JudgeInput` gains an optional `draft`, and the `suggestion_fidelity` criterion (renamed "schema fidelity" in its prompt text; the `id` is unchanged, since it is persisted in `component.judged` verdicts) verifies `draft` — the schema actually being registered — against the HTML, showing a supplied `suggestion` as context only.
  - **Rubric variant per call ([#14](https://github.com/yosuque/kohaku/issues/14)):** `judge()` now records `JudgeVerdict.rubricVariant` (`"full"` | `"no-schema"`). When neither `draft` nor `suggestion` is known, `suggestion_fidelity` is dropped and the remaining criteria are scored under exactly `l2PromotionRubricV0_3`'s own weights (rather than auto-scoring the criterion 1, which previously inflated the score by up to +0.10 for such callers — see the `promotion-schema-suggestion` changeset's updated note). `l2PromotionRubric` itself stays version `"0.4"`, and so does the persisted `JudgeVerdict.rubricVersion` in this dropped-criterion case: `rubricVersion` always names the configured rubric (the built-in default or a custom rubric's own version), never `l2PromotionRubricV0_3`'s `"0.3"` — only `rubricVariant` records that the schema criterion was dropped.
  - **Acknowledgement on the wire ([#9](https://github.com/yosuque/kohaku/issues/9)):** `POST /promotions/:artifactId/approve` accepts an optional `acknowledgedSuggestion` boolean; `Promotions.approve` (`@kohaku-ui/lineage`) and `PromotionsClient.approve` (`@kohaku-ui/client`) thread it through. It is recorded on `component.schemaEdited` as `acknowledged` (a missing value is recorded as `false`) but never enforced. `summarizeLineage`'s `review.acceptedAsIs` now requires `acknowledged === true` in addition to an empty `changed`.
  - **Extraction budget ([#15](https://github.com/yosuque/kohaku/issues/15)):** `createSchemaExtractor({ llm, timeoutMs = 20000 })` passes `abort: AbortSignal.timeout(timeoutMs)` to `generateObject` (`LlmPort.generateObject` already accepted `abort`; no `@kohaku-ui/llm` change was needed). `createPromotions({ ..., suggestConcurrency = 4 })` runs `suggestSchema` over a scan's freshly nominated candidates with at most `suggestConcurrency` in flight at once (a small worker pool, `mapWithConcurrency`, no new dependency) instead of an unbounded `Promise.all`.
  - **`summarizeLineage`'s `review` pairing** now stably sorts its input by `ts` (ties broken by original array position) before pairing nominations with reviews, so a caller no longer needs to guarantee ascending `ts` order itself.

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
  - @kohaku-ui/registry@0.3.0

## 0.2.0

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`0bea3f0`](https://github.com/yosuque/kohaku/commit/0bea3f047c496e08be629077bdd2018db153dd75) Thanks [@yosuque](https://github.com/yosuque)! - Fix `/lineage` and `/analytics/summary`'s `limit` query parsing, and the LLM retry adapter's `Retry-After` header parsing, to accept only whole decimal-digit strings (rejecting hex, scientific notation, numeric separators, and trailing garbage that a bare `Number`/`parseFloat` would otherwise silently misparse) — closing a TS/Python cross-language divergence on these inputs.

- [#9](https://github.com/yosuque/kohaku/pull/9) [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe) Thanks [@yosuque](https://github.com/yosuque)! - Bound client-supplied lineage strings (`surface`/`renderer`/`locale` to 64 chars, `specHash`/`artifactId` to 128) in host-rest's request schemas; verify a fixation's `intentHash`/`structureHash` against its own `pinnedSpec` before delivery in composer's `materializeFixation`; resolve `host-a2ui`'s per-ref data model concurrently instead of one ref at a time; and stop `<kohaku-surface>` from rebuilding its whole tree when only `onEvent`/`onNodeError`/`onActionResult` changes, plus repair properties assigned before the element was upgraded (the standard Custom Elements pattern).
- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/host-core@0.2.0
  - @kohaku-ui/data-binding@0.2.0
  - @kohaku-ui/registry@0.2.0

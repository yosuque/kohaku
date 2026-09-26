# @kohaku-ui/lineage

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

## 0.2.0

### Patch Changes

- [#18](https://github.com/yosuque/kohaku/pull/18) [`a199407`](https://github.com/yosuque/kohaku/commit/a199407b335921541bc2f1878aac1a5606f2956a) Thanks [@yosuque](https://github.com/yosuque)! - `promotions.approve()` now resumes a candidate that was persisted at `judging` (for example after a crash between `judge.start` and `judge.result`) by running the judge and continuing the chain, instead of failing with `PromotionNotPublishedError`. The Python port gains the same behaviour.

- [#9](https://github.com/yosuque/kohaku/pull/9) [`c283023`](https://github.com/yosuque/kohaku/commit/c283023c84f9544ead776d891c0ac1a790d8baa1) Thanks [@yosuque](https://github.com/yosuque)! - Fix `Promotions.reconcile()` to re-check each candidate's freshest status right after loading it, so a promotion transition that races the scan (e.g. a tenant-scoped withdraw or re-publish landing between the scan and the load) can no longer make reconcile re-publish a withdrawn candidate or unpublish a re-published one. Also skip non-projection statuses (everything but `published`/`withdrawn`) before loading them, inject the usage and generated-event indexes into `reconcile`/`listByStatus` to avoid an N+1 storage scan, and key nominate's idempotency guard by tenant while making its audit record fail-open like publish/unpublish already are.

- [#18](https://github.com/yosuque/kohaku/pull/18) [`ecb31d8`](https://github.com/yosuque/kohaku/commit/ecb31d8806df286f4c20babee48baa3c808f1f45) Thanks [@yosuque](https://github.com/yosuque)! - Harden the in-memory `(tenant, artifactId)` usage-index key: it previously joined the two values with a single delimiter character (a NUL byte in TypeScript), which is not collision-free by construction for a tenant or artifact id that could itself contain that character. It now uses a JSON array encoding, which is collision-free for any input. The key is never persisted, so nothing on disk changes. The three copies of the "latest `component.generated` per artifact" index now share one helper. Two observable consequences: a tenant of `undefined` and a tenant of `""` now produce different keys (they previously collided), and the shared `indexLatestGenerated` helper now skips an event whose `artifactId` is not a string, where one of the three former copies cast it unchecked.
- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0

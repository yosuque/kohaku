---
"@kohaku-ui/lineage": minor
"@kohaku-ui/evals": minor
"@kohaku-ui/client": minor
"@kohaku-ui/admin-react": minor
---

LLM auto-extraction of the promotion schema (advisory). `createPromotions` gains a `suggestSchema` hook, called fail-open at auto-nomination; `@kohaku-ui/evals` ships the reference extractor (`createSchemaExtractor`, stamped `l2-schema-extraction@0.1`) next to the judge, whose L2 rubric is now 0.4 with a `suggestion_fidelity` criterion. The proposal is persisted on the candidate, exposed as an additive optional `suggestion` on the candidate JSON, audited as `component.schemaSuggested`, and the reviewer's edits are audited as `component.schemaEdited`. `summarizeLineage` adds `review` (nominated → reviewed turnaround, zero-edit acceptances) and `promotions.schemaSuggested / schemaEdited`. `@kohaku-ui/admin-react`'s Promotions tab prefills from the proposal, shows a per-field diff and requires an acknowledgement before approving.

**Note for consumers who never supply a schema (no `draft`/`suggestion` passed to `judge()`):** the default gate is unchanged. A later fix (see the `@kohaku-ui/evals` / `@kohaku-ui/lineage` changesets for the judge-fidelity / rubric-variant follow-up) made `judge()` drop `suggestion_fidelity` entirely (rather than auto-scoring it 1) and score the remaining criteria under exactly `l2PromotionRubricV0_3`'s own weights whenever neither a `draft` nor a `suggestion` is known, so a no-schema consumer no longer sees the +0.10 inflation this note originally warned about. Pinning `l2PromotionRubricV0_3` explicitly remains available but is no longer necessary for that reason. **`rubricVersion` in the persisted verdict always names the configured rubric** (`"0.4"` for the built-in default, even in this dropped-criterion case) — `rubricVariant: "no-schema"` is what records that `suggestion_fidelity` was dropped, not a version change.

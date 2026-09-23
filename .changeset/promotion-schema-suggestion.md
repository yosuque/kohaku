---
"@kohaku-ui/lineage": minor
"@kohaku-ui/evals": minor
"@kohaku-ui/client": minor
"@kohaku-ui/admin-react": minor
---

LLM auto-extraction of the promotion schema (advisory). `createPromotions` gains a `suggestSchema` hook, called fail-open at auto-nomination; `@kohaku-ui/evals` ships the reference extractor (`createSchemaExtractor`, stamped `l2-schema-extraction@0.1`) next to the judge, whose L2 rubric is now 0.4 with a `suggestion_fidelity` criterion. The proposal is persisted on the candidate, exposed as an additive optional `suggestion` on the candidate JSON, audited as `component.schemaSuggested`, and the reviewer's edits are audited as `component.schemaEdited`. `summarizeLineage` adds `review` (nominated → reviewed turnaround, zero-edit acceptances) and `promotions.schemaSuggested / schemaEdited`. `@kohaku-ui/admin-react`'s Promotions tab prefills from the proposal, shows a per-field diff and requires an acknowledgement before approving.

**Note for consumers who upgrade without wiring a `suggestSchema` extractor:** rubric 0.4's `suggestion_fidelity` criterion scores 1 when no proposal is supplied, while `schema_inferability` lost 0.1 of its own weight to make room for it. Net effect for a no-suggestion candidate: the promotion score rises by up to +0.10 versus the previous rubric — the default gate becomes strictly more permissive, for a reason unrelated to the candidate's actual quality. Pin `l2PromotionRubricV0_3` (`judge({ ..., rubric: l2PromotionRubricV0_3 })`) to keep the previous gate until you wire an extractor.

# @kohaku-ui/lineage

View and component lineage for kohaku, with the promotion (L2 to L1) and fixation (L1 to L0) state machines.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/lineage zod
```

## API notes

- `createPromotions({ suggestSchema, suggestConcurrency, ... })`: `suggestSchema` is the optional schema-extraction hook run at auto-nomination; `suggestConcurrency` bounds how many candidates' extractions run at once (default 4, `DEFAULT_SUGGEST_CONCURRENCY`).
- `Promotions.approve(artifactId, draft, reviewer, scope?)`: `scope.acknowledgedSuggestion` is recorded into the `component.schemaEdited` audit event's `acknowledged` field (additive; recorded, not enforced). The configured judge receives `draft` on `PromotionJudgeContext.draft`, so it scores the schema actually being registered rather than only the candidate's machine-generated suggestion.
- `summarizeLineage().review.acceptedAsIs` counts an approval as a "zero-edit approval" only when the reviewer made no edits (`changed` is empty) **and** explicitly acknowledged the suggestion (`acknowledged: true`).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/lineage

Licensed under the Apache License, Version 2.0.

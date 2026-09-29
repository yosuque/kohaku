---
"@kohaku-ui/storage-redis": patch
"@kohaku-ui/spec-core": patch
"@kohaku-ui/client": patch
---

The Redis `pageLineage` now scans the field index that `listLineage` already chooses (tenant, correlationId, intentHash, ...) instead of hydrating and filtering the whole log, and stops after a bounded number of chunks per call, returning a short page with a `nextCursor` when the budget runs out. The `pageLineage` contract text now says pages may be short or empty while a cursor is present, and that a cursor can miss an append that was still in flight when it passed (design.md decision 53).

---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/storage-memory": patch
"@kohaku-ui/lineage": patch
"@kohaku-ui/evals": patch
"@kohaku-ui/client": patch
"@kohaku-ui/authz-hmac": patch
---

Consolidates several StoragePort/AuthzPort idioms that had drifted into per-adapter copies (code review
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

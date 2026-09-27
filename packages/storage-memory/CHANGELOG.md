# @kohaku-ui/storage-memory

## 0.3.0

### Minor Changes

- [#24](https://github.com/yosuque/kohaku/pull/24) [`76103a6`](https://github.com/yosuque/kohaku/commit/76103a60caf2bdac87fec1d4241e3e62cf317b5c) Thanks [@yosuque](https://github.com/yosuque)! - New packages extracted from the sample: `@kohaku-ui/storage-memory` (`createMemoryStoragePort`, `createFileStoragePort`) and `@kohaku-ui/authz-hmac` (`createHmacAuthzPort`). They are reference implementations of `StoragePort` / `AuthzPort` (the contract stays in `@kohaku-ui/spec-core`) and pass the shared contract suites in the private `@kohaku-ui/port-contracts`.

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

# @kohaku-ui/storage-memory

In-memory and file-backed `StoragePort` implementations for kohaku.

- `createMemoryStoragePort()` — everything in process memory. The Zero-Port quickstart default and the test double.
- `createFileStoragePort(dataDir)` — the Spec cache in memory; lineage / promotions / fixations persisted under `dataDir` (single-writer per process; see the module doc comment for the guarantees and their limits).

Both ports mark themselves `singleProcess: true` (a host does not warn about them). The memory port also declares the optional compare-and-set extension (`supportsCompareAndSet: true`: `expectedRevision` on `putPromotionState` / `putFixation` / `deleteFixation`, `StorageConflictError` on a mismatch). The file port honors the same option — it compares against the snapshot freshly re-read from disk inside its per-file lock, so a write based on a stale in-memory copy is rejected and the rejection refreshes that copy — but deliberately does **not** declare `supportsCompareAndSet`: that lock does not span processes, and two processes sharing one data directory can still lose updates. The lineage services therefore do not pass `expectedRevision` to it.

Both are reference implementations: the contract is `StoragePort` in `@kohaku-ui/spec-core` (`ports.ts`), and a product replaces them with its own store (or `@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres`) in production.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/storage-memory

Licensed under the Apache License, Version 2.0.

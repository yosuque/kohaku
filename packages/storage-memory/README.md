# @kohaku-ui/storage-memory

In-memory and file-backed `StoragePort` implementations for kohaku.

- `createMemoryStoragePort()` — everything in process memory. The Zero-Port quickstart default and the test double.
- `createFileStoragePort(dataDir)` — the Spec cache in memory; lineage / promotions / fixations persisted under `dataDir` (single-writer per process; see the module doc comment for the guarantees and their limits).

Both are reference implementations: the contract is `StoragePort` in `@kohaku-ui/spec-core` (`ports.ts`), and a product replaces them with its own store (or `@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres`) in production.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/storage-memory

Licensed under the Apache License, Version 2.0.

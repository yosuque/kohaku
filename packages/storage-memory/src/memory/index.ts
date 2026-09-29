// The "./memory" subpath: createMemoryStoragePort only, no Node-only dependency. Additive to the "."
// barrel (index.ts), which also exports createFileStoragePort (node:fs/node:path/node:crypto) — a
// consumer that only needs the pure in-process StoragePort (e.g. the static playground, apps/playground) imports from
// here instead of "." so createFileStoragePort's Node dependency is never pulled into its module graph.
// See design.md decision 57.
export { createMemoryStoragePort } from "../memory-storage-port.js";
export { MAX_SPEC_CACHE_ENTRIES } from "../spec-cache.js";

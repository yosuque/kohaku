---
"@kohaku-ui/storage-memory": patch
---

The file-backed StoragePort now serializes `appendLineage` per data directory, so `lineage.jsonl`'s line order always equals the in-memory order that `pageLineage` cursors index into, and two concurrent appends of the same id no longer both get written.

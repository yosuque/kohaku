---
"@kohaku-ui/storage-postgres": patch
---

`appendLineage` no longer fails for an oversized `correlationId`. A value longer than 256 characters is stored in the indexed `correlation_id` column as `sha256:<hex>` (a btree entry cannot hold a multi-kilobyte key), the `correlationId` filter applies the same transform so lookups by the full id still match, and the event's stored record keeps the original. The storage contract now checks a 4 KB `correlationId` against every adapter.

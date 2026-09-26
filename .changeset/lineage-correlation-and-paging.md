---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/storage-memory": minor
"@kohaku-ui/storage-redis": minor
"@kohaku-ui/storage-postgres": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/client": minor
---

Add `LineageFilter.correlationId` (payload equality) and forward (append-order) paging over the lineage
log, exposed as the optional `StoragePort.pageLineage` method (implemented by all four reference storage
adapters), `GET /lineage?order=asc&cursor=&pageSize=` on the REST profile, and `KohakuClient.lineagePages()`
on the client SDK. Both additions are backward compatible: a request that omits the new query parameters,
and a `StoragePort` that does not implement `pageLineage`, behave exactly as before.

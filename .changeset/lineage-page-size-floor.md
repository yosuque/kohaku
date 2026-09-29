---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/storage-memory": patch
"@kohaku-ui/storage-redis": patch
"@kohaku-ui/storage-postgres": patch
---

`pageLineage` now floors a fractional `pageSize` to an integer before clamping it. spec-core exports `clampLineagePageSize()`, which the array-backed pager and the Redis and Postgres adapters share: a request for `2.5` previously became `LIMIT 3.5` (a Postgres error) and made the page-size bound ineffective for the memory and Redis pagers.

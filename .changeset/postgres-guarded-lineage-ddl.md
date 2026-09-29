---
"@kohaku-ui/storage-postgres": patch
---

`ready()` no longer takes an ACCESS EXCLUSIVE lock on `kohaku_lineage` on every start: the `correlation_id` column and its index are added only when the catalog says they are missing, and the migration transaction runs with a 5 second `lock_timeout` so a start fails fast instead of queueing behind live traffic. The README gains an "Upgrading to 0.4.x" note with the `CREATE INDEX CONCURRENTLY` statement for large tables.

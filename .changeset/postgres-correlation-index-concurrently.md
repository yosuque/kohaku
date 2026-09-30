---
"@kohaku-ui/storage-postgres": patch
---

`ready()` now builds the `kohaku_lineage` `(correlation_id, seq)` index after the migration transaction commits, with `CREATE INDEX CONCURRENTLY` on a connection that has no statement timeout, instead of a plain `CREATE INDEX` inside the transaction. On a large lineage table the old build outlived the pool's default 10 s `statement_timeout`, rolled back, and made every StoragePort call fail on every retry while blocking inserts. The index is found through `pg_index.indisvalid` (an INVALID leftover is dropped and rebuilt; a long schema name no longer hides it), and a failed `ready()` retries with a 1 s to 60 s backoff instead of immediately.

With `migrate: false`, `createPostgresStoragePort` now checks that `kohaku_lineage.correlation_id` exists and fails fast, naming the `ALTER TABLE`, instead of failing every lineage INSERT with 42703 and losing audit events silently. A deployment that runs `migrate: false` must apply the 0.4.x DDL before deploying (see the README's "Upgrading to 0.4.x"). `postgresSchemaSql` adds the column through a guarded `DO` block that takes no ACCESS EXCLUSIVE lock when the column is already there. Design.md decision 53 describes the behavior.

---
"@kohaku-ui/storage-postgres": minor
---

Exports `createPostgresPool` (+ `CreatePostgresPoolOptions` / `PostgresPoolHandle`) from the package root. A caller that needs `createPostgresStoragePort` and `createPostgresRevocationStore` to share a single `pg.Pool` (rather than each opening its own) can now build the pool once with `createPostgresPool` and inject it into both via their existing `pool` option, instead of reaching into the package's internal `./connection.js`.

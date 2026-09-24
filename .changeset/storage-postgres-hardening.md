---
"@kohaku-ui/storage-postgres": minor
---

Hardens the PostgreSQL adapter for production use. A new shared `connection.ts` (`createPostgresPool`,
used internally by both `createPostgresStoragePort` and `createPostgresRevocationStore`) owns the pool
lifecycle: an owned pool now gets an `error` listener (default `console.error`, overridable via the new
`onError` option — an unhandled `error` on a `pg.Pool` otherwise crashes the process), and two new options,
`connectTimeoutMs` (default 5000) and `statementTimeoutMs` (default 10000, enforced server-side via `pg`'s
`statement_timeout`), bound a hung connection attempt or a runaway query instead of letting either hold a
pool connection forever; `maxConnections` maps to `pg.Pool`'s own `max`. An injected `pool` is unaffected
(no listener attached, never ended by `close()`).

`ready()`'s migration now runs inside one transaction guarded by a Postgres advisory lock keyed by the
schema name, so two instances migrating the same fresh schema concurrently serialize on the DDL instead
of racing it (with a one-time retry on the rare SQLSTATE 23505/42P07 race that can still surface under
concurrent first-run migration). A new `kohaku_schema_meta` table records `POSTGRES_SCHEMA_VERSION`; a
deployed schema on an unexpected version now fails `ready()` fast, naming both the expected and found
version, instead of silently drifting.

Schema changes: `kohaku_lineage.tenant` now uses `''` for "no tenant" (matching the other three tables)
instead of SQL NULL, and every tenant parameter across the whole port is normalized with
`@kohaku-ui/spec-core`'s `normalizeTenant` (an empty-string tenant now behaves exactly like an omitted one
everywhere, including `listPromotionStates("")` / `listFixations("")` / a `listLineage` tenant filter).
`kohaku_lineage.id` is now `UNIQUE` and `appendLineage` is `ON CONFLICT (id) DO NOTHING` (idempotent
re-append of an already-recorded event, one row at its original position). `kohaku_lineage.ts` is now
`COLLATE "C"` (locale-independent `since`/`until` comparisons). New indexes: a partial index on
`kohaku_spec_cache.expires_at`, and a `(seq)` index each on `kohaku_promotion_state` /
`kohaku_fixation` for their all-tenant `ORDER BY seq` scan. `putPromotionStates` is now a single batched
`INSERT ... SELECT FROM unnest(...)` statement (deduped last-write-wins) instead of one round trip per
state.

**Note for consumers**: if you have an existing deployment predating this version, read this package's
README section "Migrating from a pre-release schema" before upgrading — it covers the `kohaku_lineage.id`
uniqueness constraint and the `kohaku_lineage.tenant` NULL→`''` backfill this version's schema assumes.

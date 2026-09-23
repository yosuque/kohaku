# @kohaku-ui/storage-postgres

A PostgreSQL-backed `StoragePort` for kohaku (Spec cache, lineage, promotion state, fixation) — a reference production adapter with an idempotent schema; the contract stays `@kohaku-ui/spec-core`'s `ports.ts`.

```ts
import { createPostgresStoragePort } from "@kohaku-ui/storage-postgres";

const storage = createPostgresStoragePort({ connectionString: "postgres://localhost:5432/postgres" });
await storage.ready(); // runs the idempotent schema script once
await storage.putSpecCache("some-cache-key", spec);
const cached = await storage.getSpecCache("some-cache-key");
await storage.close();
```

## Schema

`postgresSchemaSql(schema?)` returns the whole schema as one idempotent script (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` only), safe to run on every start. `createPostgresStoragePort` runs it (plus `CREATE SCHEMA IF NOT EXISTS`) once, lazily, before the first query, unless `migrate: false`.

| table | key | notes |
|---|---|---|
| `kohaku_spec_cache` | `key` (PK) | `spec` (jsonb), `expires_at` (nullable timestamptz). Tenant-independent (cache keys are tenant-neutral by invariant). |
| `kohaku_lineage` | `seq` (PK, bigserial) | Append-only; indexed on `(type, seq)`, `(tenant, seq)`, `(intent_hash, seq)`, `(artifact_id, seq)`, `(spec_hash, seq)`, and `(ts)`. |
| `kohaku_promotion_state` | `(tenant, artifact_id)` (PK) | `tenant` defaults to `''` (tenant-neutral; a NULL cannot take part in a primary key). |
| `kohaku_fixation` | `(tenant, intent_hash)` (PK) | Same tenant-neutral convention as promotion state. |

Index names are unquoted identifiers and are prefixed with the (sanitized) schema name (`${schema}_kohaku_lineage_type_idx`). PostgreSQL namespaces index names per schema just as it does table names, so this prefix isn't needed to avoid a collision; it exists to keep index names readable and unambiguous (e.g. in `pg_indexes` or slow-query logs) when several schemas coexist in one database.

This package (Task 5 of the production-adapters plan) implements the Spec-cache half of `StoragePort` (`getSpecCache` / `putSpecCache` / `sweepExpiredSpecCache` / `close`) plus `ready()`/migration; lineage (Task 6), promotion and fixation (Task 7) are implemented in later work and currently throw `Error("not implemented")`.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/storage-postgres

Licensed under the Apache License, Version 2.0.

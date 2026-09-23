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
| `kohaku_spec_cache` | `key` (PK) | `spec` (text), `expires_at` (nullable timestamptz). Tenant-independent (cache keys are tenant-neutral by invariant). |
| `kohaku_lineage` | `seq` (PK, bigserial) | Append-only; indexed on `(type, seq)`, `(tenant, seq)`, `(intent_hash, seq)`, `(artifact_id, seq)`, `(spec_hash, seq)`, and `(ts)`. `record` (text) holds the full event. |
| `kohaku_promotion_state` | `(tenant, artifact_id)` (PK) | `tenant` defaults to `''` (tenant-neutral; a NULL cannot take part in a primary key). `state` (text). |
| `kohaku_fixation` | `(tenant, intent_hash)` (PK) | Same tenant-neutral convention as promotion state. `record` (text). |

**Every JSON payload column (`spec` / `record` / `state`) is `text`, not `jsonb`.** PostgreSQL's `jsonb` re-serializes an object's keys in its own internal order (by length, then lexicographically) rather than preserving the order they were written in, so a value written and read back comes back with reordered keys at every nesting depth — byte-different but semantically identical to what was stored. That silently breaks the byte-exact determinism the Spec cache and fixation depend on (the identical-display guarantee is an exact-JSON-equality check, not a semantic one). None of the four columns is ever queried into (no `->` / `->>` / `@>`; always fetched or filtered by the plain text columns alongside them), so storing them as `text` costs no `jsonb` capability this adapter actually uses.

Index names are unquoted identifiers and are prefixed with the (sanitized) schema name (`${schema}_kohaku_lineage_type_idx`). PostgreSQL namespaces index names per schema just as it does table names, so this prefix isn't needed to avoid a collision; it exists to keep index names readable and unambiguous (e.g. in `pg_indexes` or slow-query logs) when several schemas coexist in one database.

This package implements the whole of `StoragePort`: the Spec cache (`getSpecCache` / `putSpecCache`, with an optional TTL), lineage (`appendLineage` / `listLineage`), promotion state (`getPromotionState` / `putPromotionState` / `putPromotionStates` / `listPromotionStates`), and fixation (`getFixation` / `putFixation`, including `ifPresent` / `listFixations` / `deleteFixation`) — all tenant-scoped as described above — plus `ready()` (idempotent migration), `sweepExpiredSpecCache()`, and `close()`.

**Known limitation**: expired Spec-cache rows are treated as a miss on read (the `WHERE expires_at IS NULL OR expires_at > now()` clause), but they are not deleted automatically — `sweepExpiredSpecCache()` performs that deletion and is meant to be invoked from a cron / scheduled job, not on every read.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/storage-postgres

Licensed under the Apache License, Version 2.0.

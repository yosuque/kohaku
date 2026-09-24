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
| `kohaku_capability_revocation` | `jti` (PK) | `expires_at` (timestamptz, not null), indexed for the sweep below. See "Capability revocation". |

**Every JSON payload column (`spec` / `record` / `state`) is `text`, not `jsonb`** (the revocation table carries no JSON payload, so this choice doesn't apply to it). PostgreSQL's `jsonb` re-serializes an object's keys in its own internal order (by length, then lexicographically) rather than preserving the order they were written in, so a value written and read back comes back with reordered keys at every nesting depth — byte-different but semantically identical to what was stored. That silently breaks the byte-exact determinism the Spec cache and fixation depend on (the identical-display guarantee is an exact-JSON-equality check, not a semantic one). None of the four columns is ever queried into (no `->` / `->>` / `@>`; always fetched or filtered by the plain text columns alongside them), so storing them as `text` costs no `jsonb` capability this adapter actually uses.

Index names are unquoted identifiers and are prefixed with the (sanitized) schema name (`${schema}_kohaku_lineage_type_idx`). PostgreSQL namespaces index names per schema just as it does table names, so this prefix isn't needed to avoid a collision; it exists to keep index names readable and unambiguous (e.g. in `pg_indexes` or slow-query logs) when several schemas coexist in one database.

This package implements the whole of `StoragePort`: the Spec cache (`getSpecCache` / `putSpecCache`, with an optional TTL), lineage (`appendLineage` / `listLineage`), promotion state (`getPromotionState` / `putPromotionState` / `putPromotionStates` / `listPromotionStates`), and fixation (`getFixation` / `putFixation`, including `ifPresent` / `listFixations` / `deleteFixation`) — all tenant-scoped as described above — plus `ready()` (idempotent migration), `sweepExpiredSpecCache()`, and `close()`.

**Known limitation**: expired Spec-cache rows are treated as a miss on read (the `WHERE expires_at IS NULL OR expires_at > now()` clause), but they are not deleted automatically — `sweepExpiredSpecCache()` performs that deletion and is meant to be invoked from a cron / scheduled job, not on every read.

## Capability revocation

`createPostgresRevocationStore({ connectionString | pool, schema, migrate })` is a PostgreSQL-backed `CapabilityRevocationStore` (`@kohaku-ui/spec-core`'s `ports.ts`) — pass it as `revocations` to `@kohaku-ui/authz-hmac`'s `createHmacAuthzPort` or `@kohaku-ui/authz-jwt`'s `createJwtAuthzPort` so revocation is shared across every instance behind a load balancer, instead of the default in-memory store's per-process deny list. It shares `postgresSchemaSql`, so `ready()` migrates the same schema `createPostgresStoragePort` does (harmless when both are used against the same database: `CREATE TABLE IF NOT EXISTS`).

```ts
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { createPostgresRevocationStore } from "@kohaku-ui/storage-postgres";

const revocations = createPostgresRevocationStore({ connectionString: "postgres://localhost:5432/postgres" });
const authz = createHmacAuthzPort(secret, { revocations });

const token = await authz.issueCapability(principal, scopes);
await authz.revokeCapability(token); // signature verified first; a tampered or foreign token is rejected
await authz.verify(token, req); // { ok: false, reason: "capability revoked" }
```

`revoke()` upserts a row keyed by `jti`; `isRevoked` filters by `expires_at > now()` on read, same treatment as the Spec cache's expiry. Unlike `@kohaku-ui/storage-redis`'s TTL-keyed entry, an expired row is not dropped automatically — `sweepExpiredRevocations()` deletes it and is meant to be invoked from a cron / scheduled job, the same treatment as `sweepExpiredSpecCache()` above.

Note that `createPostgresRevocationStore` opens its own pool, separate from any `createPostgresStoragePort` pool pointed at the same database — the two are never implicitly shared, so pointing both at one deployment means sizing for two pools, not one (pass the same `pool` to both if you want a single shared pool instead).

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/storage-postgres

Licensed under the Apache License, Version 2.0.

# @kohaku-ui/storage-postgres

A PostgreSQL-backed `StoragePort` for kohaku (Spec cache, lineage, promotion state, fixation) — a reference production adapter with an idempotent schema; the contract stays `@kohaku-ui/spec-core`'s `ports.ts`.

```sh
npm install @kohaku-ui/storage-postgres pg
```

```ts
import { createPostgresStoragePort } from "@kohaku-ui/storage-postgres";

const storage = createPostgresStoragePort({ connectionString: "postgres://localhost:5432/postgres" });
await storage.ready(); // runs the idempotent schema script once
await storage.putSpecCache("some-cache-key", spec);
const cached = await storage.getSpecCache("some-cache-key");
await storage.close();
```

## Schema

`postgresSchemaSql(schema?)` returns the whole schema as one idempotent script (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` only), safe to run on every start. `createPostgresStoragePort` runs it (plus `CREATE SCHEMA IF NOT EXISTS`) once, lazily, before the first query, unless `migrate: false`. The migration is guarded by a Postgres advisory lock keyed by the schema name, so two instances migrating the same fresh schema concurrently serialize on the DDL instead of racing it.

| table | key | notes |
|---|---|---|
| `kohaku_spec_cache` | `key` (PK) | `spec` (text), `expires_at` (nullable timestamptz, partial index `WHERE expires_at IS NOT NULL`). Tenant-independent (cache keys are tenant-neutral by invariant). |
| `kohaku_lineage` | `seq` (PK, bigserial) | Append-only; `id` is `UNIQUE`, so `appendLineage` is `ON CONFLICT (id) DO NOTHING` (idempotent re-append of an already-recorded event). Indexed on `(type, seq)`, `(tenant, seq)`, `(intent_hash, seq)`, `(artifact_id, seq)`, `(spec_hash, seq)`, and `(ts)`; `ts` is `COLLATE "C"` so its `since`/`until` comparisons are byte-order, independent of the database's locale. `record` (text) holds the full event. |
| `kohaku_promotion_state` | `(tenant, artifact_id)` (PK) | `tenant` defaults to `''` (tenant-neutral; a NULL cannot take part in a primary key). `state` (text); a `(seq)` index backs the all-tenant `listPromotionStates()` scan's `ORDER BY seq`. |
| `kohaku_fixation` | `(tenant, intent_hash)` (PK) | Same tenant-neutral convention as promotion state, including the `(seq)` index for the all-tenant `listFixations()` scan. `record` (text). |
| `kohaku_capability_revocation` | `jti` (PK) | `expires_at` (timestamptz, not null), indexed for the sweep below. See "Capability revocation". |
| `kohaku_schema_meta` | `id` (PK, fixed at 1) | A single row holding `version` — see "Production" below. |

Every tenant column in this schema (`kohaku_lineage.tenant`, `kohaku_promotion_state.tenant`, `kohaku_fixation.tenant`) uses `''` for "no tenant", never SQL NULL; `@kohaku-ui/spec-core`'s `normalizeTenant` (`undefined` / `null` / `""` all collapse to "unspecified") is applied before every read, write, or filter, so an empty-string tenant behaves exactly like an omitted one everywhere in this adapter.

**Every JSON payload column (`spec` / `record` / `state`) is `text`, not `jsonb`** (the revocation and schema-meta tables carry no JSON payload, so this choice doesn't apply to them). PostgreSQL's `jsonb` re-serializes an object's keys in its own internal order (by length, then lexicographically) rather than preserving the order they were written in, so a value written and read back comes back with reordered keys at every nesting depth — byte-different but semantically identical to what was stored. That silently breaks the byte-exact determinism the Spec cache and fixation depend on (the identical-display guarantee is an exact-JSON-equality check, not a semantic one). None of these columns is ever queried into (no `->` / `->>` / `@>`; always fetched or filtered by the plain text columns alongside them), so storing them as `text` costs no `jsonb` capability this adapter actually uses. See `schema.ts`'s doc comment on `postgresSchemaSql` for the full rationale; every other file's comment on a payload column just points back here.

Index names are unquoted identifiers and are prefixed with the (sanitized) schema name (`${schema}_kohaku_lineage_type_idx`). PostgreSQL namespaces index names per schema just as it does table names, so this prefix isn't needed to avoid a collision; it exists to keep index names readable and unambiguous (e.g. in `pg_indexes` or slow-query logs) when several schemas coexist in one database.

This package implements the whole of `StoragePort`: the Spec cache (`getSpecCache` / `putSpecCache`, with an optional TTL), lineage (`appendLineage` / `listLineage`), promotion state (`getPromotionState` / `putPromotionState` / `putPromotionStates`, a single batched `INSERT ... SELECT FROM unnest(...)` / `listPromotionStates`), and fixation (`getFixation` / `putFixation`, including `ifPresent` / `listFixations` / `deleteFixation`) — all tenant-scoped as described above — plus `ready()` (idempotent, versioned migration), `sweepExpiredSpecCache()`, and `close()`.

`listLineage`'s `limit` defaults to 200 when the caller's `LineageFilter.limit` is omitted (matching `@kohaku-ui/spec-core`'s `DEFAULT_LINEAGE_LIMIT`).

**Known limitation**: expired Spec-cache rows are treated as a miss on read (the `WHERE expires_at IS NULL OR expires_at > now()` clause), but they are not deleted automatically — `sweepExpiredSpecCache()` performs that deletion and is meant to be invoked from a cron / scheduled job, not on every read.

## Production

`createPostgresStoragePort` / `createPostgresRevocationStore` share a connection lifecycle (`connection.ts`'s `createPostgresPool`, itself a public export usable on its own if you want one shared pool wired into both without going through either factory):

- **Timeouts**: an owned pool sets `connectTimeoutMs` (default 5000) and `statementTimeoutMs` (default 10000, enforced server-side on every connection via `pg`'s `statement_timeout` client option) so a network partition or a runaway query fails fast instead of hanging a pool connection forever. Both are configurable; `maxConnections` maps to `pg.Pool`'s own `max`. `connectTimeoutMs` / `statementTimeoutMs` / `maxConnections` are all ignored when you inject your own `pool` — configure it yourself instead.
- **Error listener**: an owned pool always gets an `error` listener (`pg.Pool` documents an unhandled one as a process crash) — pass `onError` to receive it yourself, or rely on the default `console.error`. An injected `pool` (the `pool` option) never gets a listener or gets ended by `close()` — attach your own listener to it and end it yourself.
- **Least privilege**: for a production deployment, prefer `migrate: false` and run `postgresSchemaSql(schema)` yourself (via `psql`, a migration tool, or a one-off script) from a privileged role as part of CI/deploy, then point the application at a role that only has `SELECT` / `INSERT` / `UPDATE` / `DELETE` on the resulting tables — the default `migrate: true` is convenient for local development and demos, but it means the application's own database role must also be able to run DDL (`CREATE TABLE`, `CREATE INDEX`, `CREATE SCHEMA`), which is broader than the DML this adapter's runtime queries need.
- **Schema versioning**: `ready()` records `POSTGRES_SCHEMA_VERSION` in `kohaku_schema_meta` the first time it migrates a schema, and fails fast (naming both the expected and the found version) if a deployed schema is already on a different one — see "Migrating from a pre-release schema" below for the one case this doesn't catch automatically.
- **Multi-instance**: the Spec cache and revocation store are safe to share across as many instances as you like (every read/write is a single statement against the shared table). Promotion state and fixation writes are only serialized *within one process* — `@kohaku-ui/spec-core`'s `ports.ts` documents this as the host's responsibility (a self-heal read-modify-write over a `(tenant, key)`). Running more than one writer process against the same promotion/fixation data needs either a single designated writer or a cross-process replacement for that serialization.

## Migrating from a pre-release schema

Schema version 1 (`POSTGRES_SCHEMA_VERSION`) is the first version this package's `ready()` checks for. If you deployed this adapter before `kohaku_schema_meta` existed, `ready()` will treat your database as version 1 the first time it runs post-upgrade (there's no row to compare against yet, so one is inserted) — this is safe **only if** your existing tables already match the current column types. Check the following before upgrading a database that predates this package's `1.x` schema-versioning support:

1. **Payload columns must be `text`, not `jsonb`.** If an earlier deployment ever used `jsonb` for a payload column (this reference schema has always used `text`, but a fork or a manual schema might not have), convert each one — this drops any jsonb key-reordering the column may already have applied, so it is a one-time, not merely cosmetic, fix:
   ```sql
   ALTER TABLE kohaku_spec_cache      ALTER COLUMN spec  TYPE text USING spec::text;
   ALTER TABLE kohaku_lineage         ALTER COLUMN record TYPE text USING record::text;
   ALTER TABLE kohaku_promotion_state ALTER COLUMN state TYPE text USING state::text;
   ALTER TABLE kohaku_fixation        ALTER COLUMN record TYPE text USING record::text;
   ```
   **Fixations recorded before this migration must be re-approved** — a `pinnedSpec` that went through a `jsonb` round-trip may already have had its key order changed before this `ALTER` ever runs, and the exact-byte-equality guarantee this adapter exists to serve cannot be retroactively restored for rows written under the old schema.
2. **`kohaku_lineage.id` needs a `UNIQUE` constraint** (added in this version, backing `appendLineage`'s `ON CONFLICT (id) DO NOTHING`):
   ```sql
   ALTER TABLE kohaku_lineage ADD CONSTRAINT kohaku_lineage_id_key UNIQUE (id);
   ```
   This fails if any duplicate `id`s already exist in the table; resolve those first (they should not occur under the current `appendLineage`, but could under a pre-`ON CONFLICT` deployment that retried a failed append).
3. **`kohaku_lineage.tenant` moved from nullable to `NOT NULL DEFAULT ''`** (matching the other three tables' tenant-neutral convention). Existing rows with a NULL tenant will no longer match a `tenant = ''` filter (the value `listLineage({ tenant: undefined })`'s per-tenant queries now use) until backfilled:
   ```sql
   ALTER TABLE kohaku_lineage ALTER COLUMN tenant SET DEFAULT '';
   UPDATE kohaku_lineage SET tenant = '' WHERE tenant IS NULL;
   ALTER TABLE kohaku_lineage ALTER COLUMN tenant SET NOT NULL;
   ```
4. **`kohaku_lineage.ts` must use the `"C"` collation**, matching the current schema (`ts text COLLATE "C" NOT NULL`) — `CREATE TABLE IF NOT EXISTS` does not retrofit this onto an existing table, and a byte/codepoint-order comparison (what `"C"` gives) rather than a locale-aware one is what `readLineage`'s ordering by `ts` relies on:
   ```sql
   ALTER TABLE kohaku_lineage ALTER COLUMN ts TYPE text COLLATE "C";
   ```

Once your schema matches the above, `ready()`'s first post-upgrade run records `kohaku_schema_meta.version = 1` and every subsequent `ready()` call verifies against it. **`ready()` also verifies, at that same first-stamp moment, that `kohaku_lineage` already carries a unique constraint/index on `id`** (step 2 above) — a pre-existing table that skipped step 2 fails `ready()` outright, pointing back at this section, rather than surfacing later as an opaque `ON CONFLICT` runtime error from the first `appendLineage` call. It does not re-verify this on every subsequent call (a schema already stamped at version 1 is trusted from then on), and it does not check steps 1, 3 or 4 at all — those still need to be applied by hand before upgrading, per the checklist above.

## Capability revocation

`createPostgresRevocationStore({ connectionString | pool, schema, migrate, ... })` is a PostgreSQL-backed `CapabilityRevocationStore` (`@kohaku-ui/spec-core`'s `ports.ts`) — pass it as `revocations` to `@kohaku-ui/authz-hmac`'s `createHmacAuthzPort` or `@kohaku-ui/authz-jwt`'s `createJwtAuthzPort` so revocation is shared across every instance behind a load balancer, instead of the default in-memory store's per-process deny list. It shares `postgresSchemaSql` and the whole connection lifecycle described in "Production" above (timeouts, the pool `error` listener, the versioned migration) with `createPostgresStoragePort`, so `ready()` migrates the same schema that port does (harmless when both are used against the same database: `CREATE TABLE IF NOT EXISTS`).

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

import { createHash } from "node:crypto";

export const DEFAULT_SCHEMA = "public";

/**
 * Longest `correlationId` stored verbatim in `kohaku_lineage.correlation_id`. A btree entry has a hard size
 * limit (about 2.7 KB), so an oversized value would make the INSERT -- and with it the audit event -- fail.
 */
export const MAX_CORRELATION_COLUMN_LENGTH = 256;

/**
 * The value stored in (and matched against) `kohaku_lineage.correlation_id` for `correlationId`: the id
 * itself, or `sha256:<hex>` of it once it exceeds {@link MAX_CORRELATION_COLUMN_LENGTH}. The event's
 * `record` keeps the original. Applied to writes and to the `correlationId` filter alike, so a lookup by
 * the full id still finds its rows. (A different, short id spelled exactly like that digest would match
 * too; the digest form is 71 characters and never produced by a request id generator.)
 */
export function correlationColumnValue(correlationId: string): string {
  if (correlationId.length <= MAX_CORRELATION_COLUMN_LENGTH) return correlationId;
  return `sha256:${createHash("sha256").update(correlationId, "utf8").digest("hex")}`;
}

/**
 * The schema version this package's `postgresSchemaSql` produces. Bumped whenever the DDL changes in a
 * way that requires a manual migration on an already-deployed database (see the README's "Migrating
 * from a pre-release schema" section). `ready()` records this in `kohaku_schema_meta` on first migrate
 * and refuses to proceed if a deployed schema is already on a different version (`connection.ts`).
 */
export const POSTGRES_SCHEMA_VERSION = 1;

/** Double-quotes a single SQL identifier, doubling any embedded double quotes. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** `"schema"."table"` with embedded double quotes doubled (SQL identifier quoting). */
export function qualifiedTable(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** Index names are unquoted identifiers; keep them to [a-z0-9_] by replacing anything else. */
function indexPrefix(schema: string): string {
  return schema.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/** PostgreSQL silently truncates an identifier to this many bytes (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_LENGTH = 63;

/** A single-quoted SQL string literal, with embedded single quotes doubled. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The whole schema as one idempotent script (`CREATE … IF NOT EXISTS` only), safe to run on every start.
 * tenant is `''` for a tenant-neutral record (a NULL cannot take part in a primary key, and — as of this
 * version — `kohaku_lineage.tenant` follows the same `''` convention as the other three tables so a
 * tenant-neutral row is never a SQL NULL anywhere in the schema).
 *
 * Every JSON payload column (`spec` / `record` / `state`) is `text`, never the PostgreSQL `jsonb` type:
 * `jsonb` re-serializes an object's keys in its own internal (length, then lexicographic) order on
 * write, so a value written then read back comes back with reordered keys at every nesting depth --
 * byte-inequal but semantically identical to what was stored. That silently breaks byte-exact
 * determinism guarantees built on these columns (the Spec cache's composeWithFixation / REST-CMP-002
 * exact-JSON-equality check; a fixation's pinnedSpec, which every subsequent compose re-reads with no
 * in-memory cache in that path -- the "same Spec, byte for byte, forever" guarantee this adapter exists
 * to serve). None of these columns is ever queried into (always fetched/filtered by the plain text
 * columns alongside them, never a jsonb operator or index), so storing them as `text` costs nothing and
 * keeps one convention across the whole schema instead of three columns doing it right and a fourth
 * inviting a "tidy this up to match" mistake later. This also matches storage-redis, which stores JSON
 * as plain strings throughout. This is documented here, once; every other file's comment on a payload
 * column just says "see schema.ts" rather than repeating this.
 */
export function postgresSchemaSql(schema: string = DEFAULT_SCHEMA): string {
  const correlation = lineageCorrelationDdl(schema);
  return `${postgresBaseSchemaSql(schema)}${correlation.guardedAddColumnSql};\n${correlation.createIndexSql};\n`;
}

/**
 * `kohaku_lineage.correlation_id` and its `(correlation_id, seq)` index (design.md #53). Added after the
 * table already existed in deployed databases, so they are kept apart from the base script: `ALTER
 * TABLE … ADD COLUMN IF NOT EXISTS` takes an ACCESS EXCLUSIVE lock even when the column is already
 * there, and `CREATE INDEX IF NOT EXISTS` takes a SHARE lock on the table before it notices the index
 * exists.
 *
 * - `ready()` checks the catalog first and adds the column (`addColumnSql`, inside the migration
 *   transaction) only when it is missing. The index is built afterwards, outside any transaction, with
 *   `createIndexConcurrentlySql` on a connection without a statement timeout (a build on a large lineage
 *   table outlives the pool's default one), and an INVALID leftover of a failed build is dropped with
 *   `dropIndexConcurrentlySql` first.
 * - `postgresSchemaSql` (which external migration tooling may run as one script) carries the column as a
 *   `DO` block that issues the `ALTER` only when the column is absent, so re-running it takes no ACCESS
 *   EXCLUSIVE lock, and the index as a plain `CREATE INDEX IF NOT EXISTS`.
 *
 * `indexName` is truncated to PostgreSQL's 63-byte identifier limit here, so it is the name the catalog
 * really holds (a longer one would never match a lookup by the untruncated name). A row written before
 * the column existed has correlation_id NULL and can never match a `correlationId` filter (there is
 * nothing to backfill it from). No `POSTGRES_SCHEMA_VERSION` bump.
 */
export function lineageCorrelationDdl(schema: string = DEFAULT_SCHEMA): {
  columnName: string;
  indexName: string;
  addColumnSql: string;
  guardedAddColumnSql: string;
  createIndexSql: string;
  createIndexConcurrentlySql: string;
  dropIndexConcurrentlySql: string;
} {
  const indexName = `${indexPrefix(schema)}_kohaku_lineage_correlation_id_idx`.slice(
    0,
    MAX_IDENTIFIER_LENGTH,
  );
  const table = qualifiedTable(schema, "kohaku_lineage");
  const addColumn = `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS correlation_id text NULL`;
  return {
    columnName: "correlation_id",
    indexName,
    addColumnSql: addColumn,
    guardedAddColumnSql: `DO $kohaku_ddl$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = ${quoteLiteral(schema)} AND table_name = 'kohaku_lineage' AND column_name = 'correlation_id'
  ) THEN
    ${addColumn};
  END IF;
END $kohaku_ddl$`,
    createIndexSql: `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (correlation_id, seq)`,
    createIndexConcurrentlySql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${table} (correlation_id, seq)`,
    dropIndexConcurrentlySql: `DROP INDEX CONCURRENTLY IF EXISTS ${qualifiedTable(schema, indexName)}`,
  };
}

/** Everything in {@link postgresSchemaSql} except the lineage correlation column and index. */
export function postgresBaseSchemaSql(schema: string = DEFAULT_SCHEMA): string {
  const t = (name: string) => qualifiedTable(schema, name);
  const ix = indexPrefix(schema);
  return `
CREATE TABLE IF NOT EXISTS ${t("kohaku_spec_cache")} (
  key text PRIMARY KEY,
  spec text NOT NULL,
  expires_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_spec_cache_expires_at_idx ON ${t("kohaku_spec_cache")} (expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${t("kohaku_lineage")} (
  seq bigserial PRIMARY KEY,
  id text NOT NULL,
  ts text COLLATE "C" NOT NULL,
  tenant text NOT NULL DEFAULT '',
  type text NOT NULL,
  intent_hash text NULL,
  artifact_id text NULL,
  spec_hash text NULL,
  record text NOT NULL,
  UNIQUE (id)
);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_lineage_type_idx ON ${t("kohaku_lineage")} (type, seq);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_lineage_tenant_idx ON ${t("kohaku_lineage")} (tenant, seq);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_lineage_intent_hash_idx ON ${t("kohaku_lineage")} (intent_hash, seq);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_lineage_artifact_id_idx ON ${t("kohaku_lineage")} (artifact_id, seq);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_lineage_spec_hash_idx ON ${t("kohaku_lineage")} (spec_hash, seq);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_lineage_ts_idx ON ${t("kohaku_lineage")} (ts);
CREATE TABLE IF NOT EXISTS ${t("kohaku_promotion_state")} (
  tenant text NOT NULL DEFAULT '',
  artifact_id text NOT NULL,
  seq bigserial NOT NULL,
  state text NOT NULL,
  PRIMARY KEY (tenant, artifact_id)
);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_promotion_state_seq_idx ON ${t("kohaku_promotion_state")} (seq);
CREATE TABLE IF NOT EXISTS ${t("kohaku_fixation")} (
  tenant text NOT NULL DEFAULT '',
  intent_hash text NOT NULL,
  seq bigserial NOT NULL,
  record text NOT NULL,
  PRIMARY KEY (tenant, intent_hash)
);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_fixation_seq_idx ON ${t("kohaku_fixation")} (seq);
-- Unlike the five tables above, this one carries no JSON payload column -- just a jti and its own
-- expiry -- so postgresSchemaSql's doc comment on payload-column typing does not apply to it.
CREATE TABLE IF NOT EXISTS ${t("kohaku_capability_revocation")} (
  jti text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix}_kohaku_capability_revocation_expires_at_idx ON ${t("kohaku_capability_revocation")} (expires_at);
-- Schema versioning (see POSTGRES_SCHEMA_VERSION's doc comment / connection.ts's ready()): a single
-- row, enforced by the fixed-id primary key + CHECK below rather than an application-level invariant.
CREATE TABLE IF NOT EXISTS ${t("kohaku_schema_meta")} (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version integer NOT NULL
);
`;
}

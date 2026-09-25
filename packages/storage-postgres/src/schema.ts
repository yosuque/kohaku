export const DEFAULT_SCHEMA = "public";

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

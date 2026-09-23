export const DEFAULT_SCHEMA = "public";

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
 * tenant is `''` for a tenant-neutral record (a NULL cannot take part in a primary key).
 */
export function postgresSchemaSql(schema: string = DEFAULT_SCHEMA): string {
  const t = (name: string) => qualifiedTable(schema, name);
  const ix = indexPrefix(schema);
  return `
-- Every JSON payload column below (spec / record / state) is text, not jsonb: jsonb re-serializes
-- object keys in its own internal (length, then lexicographic) order on write, so a value written
-- then read back comes back with reordered keys at every nesting depth -- byte-inequal but
-- semantically identical to what was stored. That silently breaks byte-exact determinism guarantees
-- built on these columns (the Spec cache's composeWithFixation / REST-CMP-002 exact-JSON-equality
-- check; a fixation's pinnedSpec, which every subsequent compose re-reads with no in-memory cache in
-- that path -- the "same Spec, byte for byte, forever" guarantee this adapter exists to serve). None
-- of the four columns is ever queried into (always fetched/filtered by the plain text columns
-- alongside them, never a jsonb operator or index), so storing them as text costs nothing and keeps
-- one convention across the whole schema instead of three columns doing it right and a fourth
-- inviting a "tidy this up to match" mistake later. This also matches storage-redis, which stores
-- JSON as plain strings throughout.
CREATE TABLE IF NOT EXISTS ${t("kohaku_spec_cache")} (
  key text PRIMARY KEY,
  spec text NOT NULL,
  expires_at timestamptz NULL
);
CREATE TABLE IF NOT EXISTS ${t("kohaku_lineage")} (
  seq bigserial PRIMARY KEY,
  id text NOT NULL,
  ts text NOT NULL,
  tenant text NULL,
  type text NOT NULL,
  intent_hash text NULL,
  artifact_id text NULL,
  spec_hash text NULL,
  record text NOT NULL
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
CREATE TABLE IF NOT EXISTS ${t("kohaku_fixation")} (
  tenant text NOT NULL DEFAULT '',
  intent_hash text NOT NULL,
  seq bigserial NOT NULL,
  record text NOT NULL,
  PRIMARY KEY (tenant, intent_hash)
);
`;
}

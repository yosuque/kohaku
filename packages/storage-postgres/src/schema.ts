export const DEFAULT_SCHEMA = "public";

/** `"schema"."table"` with embedded double quotes doubled (SQL identifier quoting). */
export function qualifiedTable(schema: string, table: string): string {
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  return `${q(schema)}.${q(table)}`;
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
CREATE TABLE IF NOT EXISTS ${t("kohaku_spec_cache")} (
  key text PRIMARY KEY,
  spec jsonb NOT NULL,
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
  record jsonb NOT NULL
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
  state jsonb NOT NULL,
  PRIMARY KEY (tenant, artifact_id)
);
CREATE TABLE IF NOT EXISTS ${t("kohaku_fixation")} (
  tenant text NOT NULL DEFAULT '',
  intent_hash text NOT NULL,
  seq bigserial NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (tenant, intent_hash)
);
`;
}

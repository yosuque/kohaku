import { describe, expect, it } from "vitest";
import { postgresSchemaSql, qualifiedTable } from "../src/schema.js";

describe("qualifiedTable", () => {
  it("double-quotes and escapes identifiers", () => {
    expect(qualifiedTable("public", "kohaku_lineage")).toBe('"public"."kohaku_lineage"');
    expect(qualifiedTable('we"ird', "t")).toBe('"we""ird"."t"');
  });
});

describe("postgresSchemaSql", () => {
  const sql = postgresSchemaSql();

  it("creates the five tables (+ the schema_meta table) idempotently in the default schema", () => {
    for (const table of [
      "kohaku_spec_cache",
      "kohaku_lineage",
      "kohaku_promotion_state",
      "kohaku_fixation",
      "kohaku_capability_revocation",
      "kohaku_schema_meta",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "public"."${table}"`);
    }
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });

  it("prefixes index names with the schema so index names stay unambiguous when several schemas coexist", () => {
    expect(postgresSchemaSql("tenant_a")).toContain(
      "CREATE INDEX IF NOT EXISTS tenant_a_kohaku_lineage_type_idx",
    );
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS public_kohaku_lineage_type_idx");
  });

  it("never uses jsonb -- every JSON payload column is text", () => {
    expect(sql).not.toMatch(/\bjsonb\b/);
    expect(sql).toContain("spec text NOT NULL");
    expect(sql).toContain("record text NOT NULL");
    expect(sql).toContain("state text NOT NULL");
  });

  it('collates kohaku_lineage.ts as "C" so ISO-8601 timestamp comparisons are locale-independent', () => {
    expect(sql).toContain('ts text COLLATE "C" NOT NULL');
  });

  it("adds the indexes this task's findings called for", () => {
    // A partial index over kohaku_spec_cache's expiry (only rows that actually have one).
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS public_kohaku_spec_cache_expires_at_idx ON "public"."kohaku_spec_cache" (expires_at) WHERE expires_at IS NOT NULL',
    );
    // `seq` indexes for the all-tenant (unfiltered) `ORDER BY seq` scans.
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS public_kohaku_promotion_state_seq_idx ON "public"."kohaku_promotion_state" (seq)',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS public_kohaku_fixation_seq_idx ON "public"."kohaku_fixation" (seq)',
    );
  });

  it("requires kohaku_lineage.id to be unique, backing appendLineage's ON CONFLICT (id) DO NOTHING", () => {
    expect(sql).toMatch(/kohaku_lineage[\s\S]*UNIQUE \(id\)/);
  });

  it("makes kohaku_schema_meta a single-row table via a fixed primary key + CHECK", () => {
    expect(sql).toMatch(/kohaku_schema_meta[\s\S]*id integer PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/);
    expect(sql).toMatch(/kohaku_schema_meta[\s\S]*version integer NOT NULL/);
  });
});

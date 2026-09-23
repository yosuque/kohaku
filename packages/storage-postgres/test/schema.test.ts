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
  it("creates the four tables idempotently in the default schema", () => {
    for (const table of [
      "kohaku_spec_cache",
      "kohaku_lineage",
      "kohaku_promotion_state",
      "kohaku_fixation",
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
});

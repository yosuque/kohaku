import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toCoreCatalogEntry } from "../scripts/core-catalog-entry.js";
import { type ComponentDefinition, coreCatalog, defineComponent } from "../src/index.js";

const base: ComponentDefinition = {
  type: "sales.kpiCard",
  version: "1.0.0",
  description: "KPI card (old)",
  propsSchema: z.object({ label: z.string() }),
  capabilities: { events: [], data: "required", children: "none" },
  deprecated: { reason: "renamed field", replacedBy: { type: "sales.kpiCardV2" } },
};

describe("core catalog export: hasMigrateProps marker", () => {
  it("is emitted as true when the definition declares migrateProps (the function itself is not exported)", () => {
    const entry = toCoreCatalogEntry(
      defineComponent({ ...base, migrateProps: (props) => ({ label: props["label"] }) }),
    );
    expect(entry).toMatchObject({ type: "sales.kpiCard", hasMigrateProps: true });
    expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty("migrateProps");
  });

  it("is absent when the definition does not declare migrateProps", () => {
    const entry = toCoreCatalogEntry(defineComponent({ ...base }));
    expect(entry).not.toHaveProperty("hasMigrateProps");
  });

  it("no core part declares migrateProps today (Python's _MIGRATE_PROPS table is empty to match)", () => {
    expect(coreCatalog.components.filter((d) => d.migrateProps != null).map((d) => d.type)).toEqual([]);
  });
});

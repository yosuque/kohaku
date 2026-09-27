// Sibling of migrate-catalog.mjs, simulating the catalog having moved on between `migrate plan` and
// `migrate apply`: sales.kpiCardNew's propsSchema is tightened (an added required `currencyCode`) without
// bumping its version — so the catalog fingerprint (type@version only, never props content) is IDENTICAL
// to migrate-catalog.mjs's, which is exactly the drift a fingerprint comparison alone cannot catch (see
// applyCatalogMigration's unconditional re-`validate`). sales.legacyList is unchanged.
import { coreCatalog, defineComponent, propsSchemaFromJsonSchema, resolveCatalog } from "@kohaku-ui/registry";

const replacement = defineComponent({
  type: "sales.kpiCardNew",
  version: "1.0.0",
  description: "replacement kpi card",
  propsSchema: propsSchemaFromJsonSchema({
    type: "object",
    properties: { label: { type: "string" }, currencyCode: { type: "string" } },
    required: ["label", "currencyCode"],
  }),
  capabilities: { events: [], data: "required", children: "none" },
});

const deprecated = defineComponent({
  type: "sales.legacyList",
  version: "1.0.0",
  description: "deprecated kpi card",
  propsSchema: propsSchemaFromJsonSchema({
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
  }),
  capabilities: { events: [], data: "required", children: "none" },
  deprecated: { reason: "superseded by sales.kpiCardNew", replacedBy: { type: "sales.kpiCardNew" } },
});

const catalog = resolveCatalog(coreCatalog, { components: [replacement, deprecated] });

export default function catalogFor() {
  return catalog;
}

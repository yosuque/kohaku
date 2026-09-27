// Fixture catalog module for cli/test/migrate.test.ts's `kohaku migrate plan/apply` coverage.
// Contract (see migrate.ts's loadCatalogFor): the default export is `(tenant?: string) => ResolvedCatalog`.
//
// Builds propsSchema from a JSON Schema via propsSchemaFromJsonSchema instead of importing zod directly —
// zod is not resolvable from this file's own location (a plain fixture outside any package's dependency
// tree; see migrate-catalog-drifted.mjs, its sibling, for why the two need genuinely distinct schemas
// rather than reusing a core component's).
import { coreCatalog, defineComponent, propsSchemaFromJsonSchema, resolveCatalog } from "@kohaku-ui/registry";

const replacement = defineComponent({
  type: "sales.kpiCardNew",
  version: "1.0.0",
  description: "replacement kpi card",
  propsSchema: propsSchemaFromJsonSchema({
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
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

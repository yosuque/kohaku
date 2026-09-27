// Fixture catalog module for cli/test/migrate.test.ts's `kohaku migrate plan/apply` coverage.
// Contract (see migrate.ts's loadCatalogFor): the default export is `(tenant?: string) => ResolvedCatalog`.
//
// Reuses presentList's own (already-validated) propsSchema for the deprecated entry instead of building a
// fresh one with zod directly — zod is not resolvable from this file's own location (a plain fixture
// outside any package's dependency tree), and there is no need to import it just to copy an existing schema.
import { coreCatalog, presentList, resolveCatalog } from "@kohaku-ui/registry";

const deprecatedList = {
  ...presentList,
  type: "sales.legacyList",
  deprecated: { reason: "superseded by presentList", replacedBy: { type: "presentList" } },
};

const catalog = resolveCatalog(coreCatalog, { components: [deprecatedList] });

export default function catalogFor() {
  return catalog;
}

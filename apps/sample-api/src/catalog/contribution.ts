import type { ComponentDefinition } from "@kohaku-ui/registry";
import type { CatalogContribution } from "@kohaku-ui/spec-core";
import { salesKpiCard } from "@kohaku-ui-sample/parts";

/**
 * Contribution of sales-domain-specific components (a CatalogContribution), delivered via a federated merge
 * with the core catalog. The component definitions themselves live in @kohaku-ui-sample/parts (single
 * source shared with sample-web / sample-mcp's renderer — see docs/user-guide.md's "Adding a part" and
 * design.md #68); this module only wraps them for the catalog merge.
 */
export const salesContribution: CatalogContribution<ComponentDefinition> = {
  components: [salesKpiCard],
};

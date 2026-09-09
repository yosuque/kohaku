import { type ComponentDefinition, defineComponent } from "@kohaku-ui/registry";
import type { CatalogContribution } from "@kohaku-ui/spec-core";
import { z } from "zod";

/**
 * Contribution of sales-domain-specific components (a CatalogContribution).
 * Delivered via a federated merge with the core catalog.
 */
export const salesKpiCard = defineComponent({
  type: "sales.kpiCard",
  version: "1.0.0",
  description:
    "Card display of a single KPI. The data reference is one row of {label, value, format, note} " +
    "(format: currency|percent|number). Use it to highlight a summary or attainment.",
  propsSchema: z.object({
    /** Specify only when you want to override the data row's label */
    label: z.string().optional(),
  }),
  capabilities: { events: [], data: "required", children: "none" },
  fallback: {
    type: "presentMarkdown",
    mapProps: () => ({ markdown: "(The KPI card is not available on this surface)" }),
  },
});

export const salesContribution: CatalogContribution<ComponentDefinition> = {
  components: [salesKpiCard],
};

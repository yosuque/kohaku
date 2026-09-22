import { defineIntent, defineVocabulary, type IntentBuilder } from "@kohaku-ui/intents";
import { z } from "zod";

const region = defineVocabulary("region", { japan: "Japan", north_america: "North America" });

/** One Intent = one definition: SemanticPort def, GUI facets and the MCP tool all derive from it. */
export const intents: IntentBuilder[] = [
  defineIntent({
    canonical: "sales.summary",
    description: "Revenue by region for the current period",
    source: "my-product",
    params: z.object({ region: region.enum().optional() }),
    examples: ["How are sales doing by region?"],
    queries: () => [{ uri: "query://my-product/sales_summary" }],
  }),
];

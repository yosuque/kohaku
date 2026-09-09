import { z } from "zod";
import { defineComponent } from "../define.js";

export const presentList = defineComponent({
  type: "presentList",
  version: "1.0.0",
  description:
    "List that applies the children template to each row of a data reference ($ref) and lays them out. " +
    "Use it when each row needs a free card-like layout (heading + metric + button, etc.). For a simple table, use presentSpreadsheet. " +
    'Within the template, props can use "$row.<column name>", which is substituted with each row\'s data.',
  propsSchema: z.object({
    gap: z.enum(["none", "sm", "md", "lg"]).default("sm"),
    maxItems: z.number().int().positive().max(100).optional(),
    emptyText: z.string().default("(No data)"),
  }),
  capabilities: { events: ["itemClick"], data: "required", children: "optional" },
  fallback: {
    type: "presentSpreadsheet",
    mapProps: () => ({ editable: false }),
  },
});

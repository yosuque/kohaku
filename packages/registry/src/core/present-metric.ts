import { z } from "zod";
import { defineComponent } from "../define.js";

export const presentMetric = defineComponent({
  type: "presentMetric",
  version: "1.0.0",
  description:
    "Presents a single KPI value. Displays the value (valueColumn) and the change (deltaColumn) from the first row of a data reference ($ref). " +
    "Use it when you want to show one number large (a single metric such as sales, count, or ratio). For a table or multiple values, use presentSpreadsheet / presentChart.",
  propsSchema: z.object({
    label: z.string().min(1),
    valueColumn: z.string().min(1),
    deltaColumn: z.string().optional(),
    format: z.enum(["number", "currency", "percent"]).default("number"),
    unit: z.string().optional(),
    // Currency code (ISO 4217) when format="currency". When unspecified, the renderer defaults to "JPY".
    currency: z.string().optional(),
    positiveIsGood: z.boolean().default(true),
  }),
  capabilities: { events: [], data: "required", children: "none" },
  fallback: {
    type: "presentMarkdown",
    mapProps: (p) => ({ markdown: `**${String(p["label"] ?? "")}**` }),
  },
});

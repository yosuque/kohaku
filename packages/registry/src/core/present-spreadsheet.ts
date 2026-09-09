import { z } from "zod";
import { defineComponent } from "../define.js";

export const presentSpreadsheet = defineComponent({
  type: "presentSpreadsheet",
  // 1.1.0: added the serverSide property (propsSchema change = version-bump convention).
  version: "1.1.0",
  description:
    "Displays a data reference ($ref) as a table. Omitting the column definitions uses the data's columns as-is. " +
    "A row click (rowClick) can fire a drill-down event. " +
    "When serverSide=true, sorting/paging is done not locally but by re-fetching from the server (binding.resolve's page/sort).",
  propsSchema: z.object({
    editable: z.boolean().default(false),
    columns: z
      .array(
        z.object({
          key: z.string().min(1),
          label: z.string().optional(),
          type: z.enum(["string", "number", "boolean", "date"]).optional(),
        }),
      )
      .optional(),
    sortBy: z
      .object({
        field: z.string().min(1),
        dir: z.enum(["asc", "desc"]),
      })
      .optional(),
    pageSize: z.number().int().positive().max(500).optional(),
    /**
     * Server-side paging/sorting. When the default false, sorting and slicing are done locally
     * (current behavior). When true, sorting/paging is done by re-fetching via
     * binding.resolve(ref, {page, sort}) (for large datasets).
     */
    serverSide: z.boolean().default(false),
  }),
  capabilities: {
    events: ["rowClick", "sortChange", "cellEdit"],
    data: "required",
    children: "none",
    editable: true,
  },
  fallback: {
    type: "presentMarkdown",
    mapProps: () => ({ markdown: "(This table does not support text rendering)" }),
  },
});

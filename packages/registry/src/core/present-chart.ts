import { z } from "zod";
import { defineComponent } from "../define.js";

export const presentChart = defineComponent({
  type: "presentChart",
  // 1.1.0: added the pointClick event and the referenceLines property (capabilities/propsSchema change = version-bump convention).
  version: "1.1.0",
  description:
    "Charts a data reference ($ref). x is the dimension column, y is the numeric column(s). " +
    "Choose line for time series, bar for category comparison, and pie for composition. Data is passed by reference only and never contains row data. " +
    "To enable drill-down on a data-point click, declare pointClick in events " +
    "(the payload resolves to $row.<x column> / when series is set, $row.<series column> and $row.<y column>; valid for bar/line/area). " +
    "To show horizontal lines for targets/thresholds, list { value, label? } in referenceLines (horizontal lines on the y axis).",
  propsSchema: z.object({
    kind: z.enum(["bar", "line", "area", "pie", "scatter"]),
    x: z.string().min(1),
    y: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    series: z.string().optional(),
    stacked: z.boolean().optional(),
    title: z.string().optional(),
    /** Reference lines for targets / thresholds (v1 supports only horizontal lines on the y axis). value is on the same numeric scale as y. */
    referenceLines: z
      .array(
        z.object({
          value: z.number(),
          label: z.string().optional(),
          axis: z.literal("y").optional(),
        }),
      )
      .optional(),
  }),
  // pointClick: drill-down on a data-point click (fires only when declared; without a declaration it stays non-interactive).
  capabilities: { events: ["pointClick"], data: "required", children: "none" },
  fallback: {
    type: "presentSpreadsheet",
    mapProps: () => ({ editable: false }),
  },
});

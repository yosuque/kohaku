import { z } from "zod";
import { defineComponent } from "../define.js";

export const layoutStack = defineComponent({
  type: "layout.stack",
  version: "1.0.0",
  description:
    "Container that arranges child elements vertically or horizontally. Use it for the screen's root structure. Children are referenced by ID via children.",
  propsSchema: z.object({
    direction: z.enum(["vertical", "horizontal"]).default("vertical"),
    gap: z.enum(["none", "sm", "md", "lg"]).default("md"),
  }),
  capabilities: { events: [], data: "none", children: "optional" },
});

export const layoutGrid = defineComponent({
  type: "layout.grid",
  version: "1.0.0",
  description:
    "Container that arranges child elements in an equal-width grid. Use it for laying out KPI cards side by side, etc.",
  propsSchema: z.object({
    columns: z.number().int().min(1).max(6).default(2),
    gap: z.enum(["none", "sm", "md", "lg"]).default("md"),
  }),
  capabilities: { events: [], data: "none", children: "optional" },
});

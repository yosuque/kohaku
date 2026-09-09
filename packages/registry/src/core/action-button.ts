import { z } from "zod";
import { defineComponent } from "../define.js";

export const actionButton = defineComponent({
  type: "action.button",
  version: "1.0.0",
  description:
    "Action button. Fires a declared operation (intent.patch / action.invoke / state.set) on the press event. " +
    "Use it to prompt the user for a single action. Has a label and an importance " +
    "(variant: primary=main action / secondary=secondary action / danger=destructive action).",
  propsSchema: z.object({
    label: z.string().min(1),
    variant: z.enum(["primary", "secondary", "danger"]).default("primary"),
    disabled: z.boolean().optional(),
  }),
  capabilities: { events: ["press"], data: "none", children: "none" },
  fallback: {
    type: "presentMarkdown",
    mapProps: (p) => ({
      markdown: `(Action "${String(p["label"] ?? "")}" is not available on this surface)`,
    }),
  },
});

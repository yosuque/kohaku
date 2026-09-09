import { z } from "zod";
import { defineComponent } from "../define.js";

export const textHeading = defineComponent({
  type: "text.heading",
  version: "1.0.0",
  description: "Heading text. level 1–6. Use it for a view's title.",
  propsSchema: z.object({
    level: z.number().int().min(1).max(6),
    text: z.string().min(1),
  }),
  capabilities: { events: [], data: "none", children: "none" },
});

export const presentMarkdown = defineComponent({
  type: "presentMarkdown",
  version: "1.0.0",
  description:
    "Markdown rich text. Descriptions, annotations, and the text-fallback terminal for any component.",
  propsSchema: z.object({
    markdown: z.string(),
  }),
  capabilities: { events: [], data: "none", children: "none" },
});

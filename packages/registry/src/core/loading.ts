import { z } from "zod";
import { defineComponent } from "../define.js";

/**
 * Placeholder for the in-progress streaming form (skeleton).
 * Shown by composeStream until the final Spec is settled. Since it is not for generation, it is
 * removed from the L1 generation vocabulary via generation:"excluded" so the LLM cannot output it
 * structurally. The text-fallback terminal is presentMarkdown.
 */
export const uiLoading = defineComponent({
  type: "ui.loading",
  version: "1.0.0",
  description:
    "Loading placeholder (skeleton). A runtime-only component used to show the in-progress form during streaming; it is not a generation target.",
  propsSchema: z.object({
    label: z.string().default("Loading…"),
  }),
  capabilities: { events: [], data: "none", children: "none" },
  generation: "excluded",
  fallback: {
    type: "presentMarkdown",
    mapProps: (p) => ({ markdown: String(p["label"] ?? "Loading…") }),
  },
});

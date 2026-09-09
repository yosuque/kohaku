import { z } from "zod";
import { defineComponent } from "../define.js";

/**
 * Tab container (kohaku >= 0.2). The source of truth for the selection is the client-local state
 * $state.<stateKey>, and parts outside the tabs can react to the same key via visibleWhen. Tab
 * switching is a local operation inside the renderer that calls useSpecState().set directly (an
 * events declaration is not required — this prevents the accident of a tab dying due to a missed
 * declaration).
 *
 * Because state is not opened to L1 generation, generation:"excluded" (the LLM cannot output it
 * structurally). Used in L0 fixed Specs, hand-written Specs, and promotion templates. The fallback is
 * layout.stack (all panels stacked vertically).
 */
export const layoutTabs = defineComponent({
  type: "layout.tabs",
  version: "1.0.0",
  description:
    "Container that switches child panels (layout.tab) with tabs. The selection is held in state[stateKey], and only the selected tab's layout.tab is rendered.",
  propsSchema: z.object({
    stateKey: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  }),
  capabilities: { events: ["select"], data: "none", children: "optional" },
  generation: "excluded",
  fallback: { type: "layout.stack", mapProps: () => ({}) },
});

/**
 * A single tab panel (child of layout.tabs). Rendered only when value matches state[stateKey].
 * The parent layout.tabs handles the show/hide, so the panel itself carries no visibleWhen.
 * generation:"excluded".
 */
export const layoutTab = defineComponent({
  type: "layout.tab",
  version: "1.0.0",
  description:
    "A child panel of layout.tabs. value is the tab's identifier value, label is the tab heading. Put the contents in children.",
  propsSchema: z.object({
    value: z.string().min(1),
    label: z.string().min(1),
  }),
  capabilities: { events: [], data: "none", children: "optional" },
  generation: "excluded",
  fallback: { type: "layout.stack", mapProps: () => ({}) },
});

import { z } from "zod";
import { defineComponent } from "../define.js";

/**
 * Lightweight select control (control.select, kohaku >= 0.2 [Draft]).
 * Emits the selected value ($value) on a change event and, combined with `emit:"state.set"`,
 * updates $state. Feeding that $state into a reference-passed parameter via data.bind establishes a
 * cross-filter without firing a compose.
 *
 * generation:"excluded": kept out of the L1 generation vocabulary (same treatment as state / visibleWhen).
 * A structural containment that does not let the LLM decide the bind value-range allowlist. A part for
 * L0 fixed Specs, hand-written Specs, and promotion templates.
 * It holds no data (options are static props; the source of truth for authorization is on the data.bind.values side).
 */
export const controlSelect = defineComponent({
  type: "control.select",
  version: "1.0.0",
  description:
    "Select control. Fires the selected value on the change event and, combined with state.set, updates client-local state. " +
    "Feeding that state into a data-reference parameter via data.bind makes it a cross-filter (a linked update with no compose round-trip). " +
    "options are static choices (string or {value,label}). Single-value discrete selection only (free input and multi-select are not supported).",
  propsSchema: z.object({
    /** Choices. A string is equivalent to `{ value:label }` (same shape as present-form; backward compatible). */
    options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).min(1),
    /** Initial selected value (kept consistent with data.bind's initial variant = spec.state's initial value). */
    value: z.string().optional(),
    /** Label for the leading empty-value option representing "no selection" (when omitted, no empty option is rendered). */
    placeholder: z.string().optional(),
    /** Accessible name (aria-label). Gives a name to a standalone control. */
    label: z.string().optional(),
  }),
  capabilities: { events: ["change"], data: "none", children: "none" },
  // Not opened up to L1 generation (same treatment as state / visibleWhen).
  generation: "excluded",
  fallback: {
    type: "presentMarkdown",
    mapProps: (p) => ({ markdown: `**${String(p["label"] ?? p["value"] ?? "")}**` }),
  },
});

import { z } from "zod";
import { defineComponent } from "../define.js";

/**
 * Modal dialog (overlay.dialog, kohaku >= 0.2). Hosts confirmation flows (the final confirmation of a
 * danger action) or completion forms. **Convention: open/close is not held in props but controlled
 * declaratively via visibleWhen**: button press → state.set sets open=true → the dialog shows via
 * visibleWhen — a "confirmation flow by declaration alone" (no new state mechanism is added for
 * open/close). The close event fires on Esc, the × button, or a backdrop click, and is forwarded
 * upstream only when declared — normally you fold the open flag back yourself via emit:"state.set".
 * The body places arbitrary parts (presentForm / action.button, etc.) in children. The fallback is
 * layout.stack (a functional downgrade that drops the modal chrome and renders the body inline).
 *
 * Downgrade trade-off: the negotiate mechanism goes only as far as "prop mapping + children handoff"
 * and cannot inject a new child node (a text part carrying the title). Because layout.stack has no
 * title prop, downgrading **loses title / description** (the functional body — children = the confirm
 * button / completion form — is preserved). Conversely, downgrading to presentMarkdown could copy
 * title/description into markdown, but presentMarkdown is children:"none" and would drop the whole
 * body (form / button). Since both cannot be satisfied, the functional body is prioritized and
 * layout.stack is chosen (the loss of the danger confirmation's "question" = title/description is
 * documented in docs/specification.md).
 *
 * State-linked parts follow the existing policy of not being opened to L1 generation (same as
 * layout.tabs / control.select), so generation:"excluded". Used in L0 fixed Specs, hand-written
 * Specs, and promotion templates.
 */
export const overlayDialog = defineComponent({
  type: "overlay.dialog",
  version: "1.0.0",
  description:
    "Modal dialog. Hosts confirmation flows or completion forms. Open/close is not held in props but controlled via visibleWhen; " +
    "close (Esc / the × button / a backdrop click) is forwarded only when declared (normally you fold the open flag back via state.set). The body goes in children.",
  propsSchema: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    variant: z.enum(["default", "danger"]).default("default"),
  }),
  capabilities: { events: ["close"], data: "none", children: "optional" },
  generation: "excluded",
  fallback: { type: "layout.stack", mapProps: () => ({}) },
});

/**
 * Toast notification (overlay.toast, kohaku >= 0.2). Transient display for completion / errors.
 * Visibility is controlled declaratively via visibleWhen, same as dialog. Specifying durationMs makes
 * it fire a dismiss event and auto-vanish after the elapsed time (it closes itself when an
 * emit:"state.set" is declared). When omitted, it does not disappear. tone sets the coloring
 * (info/success/error); error interrupts the screen reader (role=alert). It does not steal focus.
 * generation:"excluded" (the policy of not opening state-linked parts). The fallback is
 * presentMarkdown (which shows message).
 */
export const overlayToast = defineComponent({
  type: "overlay.toast",
  version: "1.0.0",
  description:
    "Toast notification (transient display for completion / errors). Visibility is controlled via visibleWhen. After durationMs elapses it fires dismiss and auto-vanishes" +
    " (it closes itself when a state.set is declared; when omitted, it does not disappear). tone sets the coloring; error interrupts via role=alert.",
  propsSchema: z.object({
    message: z.string().min(1),
    tone: z.enum(["info", "success", "error"]).default("info"),
    durationMs: z.number().int().positive().optional(),
  }),
  capabilities: { events: ["dismiss"], data: "none", children: "none" },
  generation: "excluded",
  fallback: {
    type: "presentMarkdown",
    mapProps: (p) => ({ markdown: String(p["message"] ?? "") }),
  },
});

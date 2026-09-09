import { z } from "zod";
import { JsonValueSchema } from "./json.js";

/** "table1.rowClick" — the component ID and event name joined by a dot. */
export const EventOnSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*\.[a-zA-Z][a-zA-Z0-9]*$/);

/**
 * The event model. Returns in-component operations to the Composition Service.
 * The payload allows runtime placeholder strings like "$row.region".
 */
export const EventBindingSchema = z.object({
  on: EventOnSchema,
  // "state.set" is the kohaku >= 0.2 client-local state update. It completes within the Renderer and is
  // not sent to the server (SPEC-EVT-002; the payload holds a static key and the value to set).
  emit: z.enum(["intent.patch", "intent.replace", "action.invoke", "state.set"]),
  payload: z.record(z.string(), JsonValueSchema),
});

export type EventBinding = z.infer<typeof EventBindingSchema>;

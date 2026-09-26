import type { GuiAction, JsonObject } from "@kohaku-ui/spec-core";
import { A2UI_FORWARD_ACTION } from "./from-a2ui.js";
import { A2uiIngestError } from "./reduce.js";

/**
 * The client→agent action shape `toA2uiClientAction` produces. Per the RC facts note: "renderer → agent の
 * action: `{ action: { name, context } }` (transport依存)" — deliberately minimal (no `surfaceId` /
 * `sourceComponentId` / `timestamp`, unlike the existing v0.9.1 `A2uiAction` type `fromA2uiEvent` consumes):
 * the facts note calls the rest of the envelope transport-dependent, not part of this core body. **Verify
 * against the A2UI v1.0 spec** if a concrete transport turns out to need those fields threaded back in too —
 * a caller wiring a real transport can always add them alongside this return value (it already knows the
 * surfaceId/sourceComponentId it dispatched the interaction on).
 */
export interface A2uiClientActionMessage {
  action: {
    name: string;
    context: JsonObject;
  };
}

/**
 * The reverse of `fromA2uiEvent`: converts a kohaku `GuiAction` (the result of a user interacting with a
 * component in an *ingested* surface) back into the wire form the original third-party agent expects to
 * receive.
 *
 * This is the **only** correct way to handle a `GuiAction` whose write-action name (spec-core's
 * `resolveWriteActionName`) is `A2UI_FORWARD_ACTION` — a host MUST recognize that sentinel and route here
 * *before* ever considering dispatching to its `DomainPort` (see `A2UI_FORWARD_ACTION`'s doc in
 * `from-a2ui.ts`, and the package README's "Inbound: A2UI agent → kohaku Spec (ingest)" section). The
 * actual forwarded event name/context live nested in `params.event`/`params.context` (`fromA2ui`'s
 * `attachEvent` puts them there precisely so a third-party agent's own `context` — which could otherwise
 * contain an `action` key — never reaches a position `resolveWriteActionName` reads); this function throws
 * `A2uiIngestError` if `params` is not shaped that way, since calling it on an unrelated `GuiAction` is a
 * host wiring bug, not a case to silently paper over.
 */
export function toA2uiClientAction(action: GuiAction): A2uiClientActionMessage {
  const { params } = action;
  if (params["action"] !== A2UI_FORWARD_ACTION || typeof params["event"] !== "string") {
    throw new A2uiIngestError(
      `toA2uiClientAction: expected a GuiAction forwarded from A2UI ingest ` +
        `({params: {action: "${A2UI_FORWARD_ACTION}", event: string, context}}), got params: ${JSON.stringify(params)}`,
    );
  }
  const context = params["context"];
  const isJsonObject = typeof context === "object" && context !== null && !Array.isArray(context);
  return { action: { name: params["event"], context: isJsonObject ? (context as JsonObject) : {} } };
}

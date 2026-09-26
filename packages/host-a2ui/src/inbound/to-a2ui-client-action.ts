import type { GuiAction, JsonObject } from "@kohaku-ui/spec-core";

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
 * component in an *ingested* surface — see `fromA2ui`'s `attachEvent`, which synthesizes exactly this
 * `{kind:"gui", action: "<id>.<eventName>", params}` shape from the original agent's `action.event`) back
 * into the wire form the original third-party agent expects to receive.
 *
 * `action.action` is split on its *first* `.` — the inverse of `attachEvent`'s `on: "${id}.${eventNamePart}"`
 * construction — so the recovered `name` is exactly the (possibly sanitized — see `fromA2ui`'s
 * `toKohakuEventNamePart`) event name segment, not kohaku's own `<id>.<eventName>` convention. `context`
 * (kohaku's already-resolved `params`) is copied straight through, matching `fromA2uiEvent`'s own
 * `context -> params` direction reversed.
 */
export function toA2uiClientAction(action: GuiAction): A2uiClientActionMessage {
  const dot = action.action.indexOf(".");
  const name = dot >= 0 ? action.action.slice(dot + 1) : action.action;
  return { action: { name, context: action.params } };
}

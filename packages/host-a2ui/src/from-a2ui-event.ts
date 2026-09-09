import type { GuiAction } from "@kohaku-ui/spec-core";
import type { A2uiAction, A2uiClientEventV1, A2uiUnsupportedResult } from "./types.js";

/**
 * Convert an A2UI client action (client→server) back into a kohaku GuiAction (v0.9.1).
 *
 * `name` is the firing component's `action.event.name`. Because toA2ui's event mapping makes it
 * `<componentId>.<eventName>` (the same shape as kohaku's EventBinding.on), it is copied straight into action.
 * `context` (with data bindings already resolved) is copied into params. This is the shape that enters normalize → resolveQuery.
 */
export function fromA2uiEvent(action: A2uiAction): GuiAction;
/**
 * Accept the v1.0 RC's `callAgentFunction` / `rendererFunctionResponse` client messages (verified against
 * the v1.0 RC's `renderer_to_agent.json` schema). kohaku's GuiAction model has no function-call channel
 * (no renderer-side catalog function concept), so these are reported as an explicit
 * {@link A2uiUnsupportedResult} rather than guessing at a GuiAction shape or silently dropping the call.
 * The existing `action` overload above is unchanged — this is purely additive.
 */
export function fromA2uiEvent(event: A2uiClientEventV1): A2uiUnsupportedResult;
export function fromA2uiEvent(input: A2uiAction | A2uiClientEventV1): GuiAction | A2uiUnsupportedResult {
  if ("callAgentFunction" in input) {
    return {
      kind: "unsupported",
      reason:
        `A2UI v1.0 "callAgentFunction" (functionCallId: ${input.callAgentFunction.functionCallId}) has no kohaku ` +
        "equivalent: GuiAction models user-triggered events, not a renderer-invoked function-call channel.",
    };
  }
  if ("rendererFunctionResponse" in input) {
    return {
      kind: "unsupported",
      reason:
        `A2UI v1.0 "rendererFunctionResponse" (functionCallId: ${input.rendererFunctionResponse.functionCallId}) ` +
        "has no kohaku equivalent: kohaku never emits callRendererFunction, so there is no response to correlate it with.",
    };
  }
  return {
    kind: "gui",
    action: input.name,
    params: input.context ?? {},
  };
}

import type { JsonObject } from "./schema/json.js";
import type { UISpec } from "./schema/spec.js";

/**
 * The rule for resolving the action name a write event (emit==="action.invoke") invokes (single
 * source of truth). Prefers the target component's props.action (presentForm), falling back to the
 * event payload's action (action.button). If neither is present, undefined (the renderer falls back
 * to forwarding, the host issues no write scope).
 *
 * Both renderer-core (resolveActionName on the execution path) and the host (collectWriteActions for
 * write capability issuance) consume this function. If action resolution for authorization and
 * execution drifted apart, writes would silently 403, so we keep no duplicate of the rule (the
 * "spec-core is the definition site" principle).
 */
export function resolveWriteActionName(
  props: JsonObject | undefined,
  payload: JsonObject,
): string | undefined {
  const fromProps = props?.["action"];
  if (typeof fromProps === "string" && fromProps.length > 0) return fromProps;
  const fromPayload = payload["action"];
  if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
  return undefined;
}

/**
 * Collects the target action names for writes (emit==="action.invoke") from a Spec's events (single
 * source of truth). Action-name resolution is delegated to resolveWriteActionName (so write-scope
 * issuance for authorization and action resolution on the execution path never diverge). Symmetric to
 * read covering "references the UI reads", this covers "writes the UI declared". Both host-rest
 * (issueCapabilityForSpec on the REST side) and host-mcp-apps (issueCapability on the MCP side)
 * consume this so the write capability issuance rule matches across both profiles.
 */
export function collectWriteActions(spec: UISpec): string[] {
  const byId = new Map(spec.components.map((c) => [c.id, c]));
  const actions = new Set<string>();
  for (const e of spec.events) {
    if (e.emit !== "action.invoke") continue;
    const node = byId.get(e.on.split(".")[0] ?? "");
    const action = resolveWriteActionName(node?.props, e.payload);
    if (action != null) actions.add(action);
  }
  return [...actions];
}

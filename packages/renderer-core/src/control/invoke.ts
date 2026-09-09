import type { ActionResult, BindingClient } from "@kohaku-ui/data-binding";
import {
  type ComponentNode,
  type JsonObject,
  resolveWriteActionName,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { DataInvalidationBus } from "../stores/invalidation-bus.js";
import { resolvePayloadTemplate } from "./emit.js";

/**
 * The decision for directly executing a write (action.invoke) — the pure-logic
 * part of useInvokeAction. No side effects.
 * - `invoke`: when the declared binding has emit==="action.invoke", a
 *   BindingClient exists, and the action name can be determined. Returns the
 *   resolved action name and payload (execution and the invalidates publish are
 *   done by the caller).
 * - `forward`: when the above is not satisfied. The caller falls back to the
 *   conventional path via resolveEmit(eventName, runtime) (discard undeclared /
 *   state.set handled internally / onEvent forwarding).
 *
 * hasBinding is whether a BindingClient is configured (the instance is held on the
 * renderer side; only the boolean is passed in). `row` is the current row
 * auto-supplied inside a row template when runtime.row is unspecified (used for
 * $row.* resolution).
 */
export type InvokeTarget = { kind: "invoke"; action: string; payload: JsonObject } | { kind: "forward" };

export function resolveInvokeTarget(
  spec: UISpec,
  node: ComponentNode,
  eventName: string,
  runtime: JsonObject,
  options: { hasBinding: boolean; row?: JsonObject | null },
): InvokeTarget {
  const { hasBinding, row } = options;
  const on = `${node.id}.${eventName}`;
  const bindingDecl = spec.events.find((e) => e.on === on);

  // Anything that does not satisfy the direct-execution conditions is delegated to
  // the conventional path (resolveEmit / onEvent forwarding).
  if (bindingDecl == null || bindingDecl.emit !== "action.invoke" || !hasBinding) {
    return { kind: "forward" };
  }

  // Payload resolution uses the same grammar as resolveEmit ($row/$value + row context).
  const effectiveRuntime = row != null && runtime["row"] === undefined ? { ...runtime, row } : runtime;
  const payload = resolvePayloadTemplate(bindingDecl.payload, effectiveRuntime);
  const action = resolveActionName(node, payload);
  if (action == null) {
    // When the action name cannot be determined (neither props.action nor
    // payload.action is present), fall back to forwarding.
    return { kind: "forward" };
  }
  return { kind: "invoke", action, payload };
}

/**
 * Determines the action name to execute. presentForm takes it from props.action;
 * action.button takes it from the action key of the resolved payload (or from
 * props.action). If neither is present, returns undefined (forwarding fallback).
 * The actual rule lives in spec-core's resolveWriteActionName (the single source
 * of truth) — this consumes the same function as the host-side write-capability
 * issuance (collectWriteActions), so authorization and execution resolution do not
 * diverge.
 */
export function resolveActionName(node: ComponentNode, payload: JsonObject): string | undefined {
  return resolveWriteActionName(node.props, payload);
}

/**
 * Progress state of a write (action.invoke). The framework-free source of truth.
 * renderer-react and renderer-wc each re-export this type under the same name they
 * exported before (their own local declarations were duplicates of this shape).
 */
export type ActionPhase =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "succeeded"; result: unknown }
  | { phase: "failed"; message: string };

export interface RunInvokeTargetDeps {
  /** The reference-resolution client (already known non-null at the call site — resolveInvokeTarget only returns "invoke" when hasBinding is true). */
  binding: BindingClient;
  /** The data invalidation bus that invalidates on ActionResult.invalidates (the small loop). */
  bus: DataInvalidationBus;
  /** Completion notification for the write (success/failure). Optional, matching each renderer's context. */
  onActionResult?: (args: {
    componentId: string;
    action: string;
    phase: "succeeded" | "failed";
    result?: unknown;
    message?: string;
  }) => void;
}

/**
 * Directly executes the write path decided by resolveInvokeTarget (kind === "invoke"):
 * pending → binding.invokeAction → succeeded/failed phase → bus.publish(invalidates) →
 * onActionResult, in that exact order. The framework-free source of truth for the
 * sequence, avoiding duplicating it in renderer-react's useInvokeAction and
 * renderer-wc's tree.ts invokeAction. onPhase reports progress (React's setState /
 * WC's phase callback); nodeId identifies the component in onActionResult.
 */
export async function runInvokeTarget(
  target: Extract<InvokeTarget, { kind: "invoke" }>,
  deps: RunInvokeTargetDeps,
  nodeId: string,
  onPhase: (phase: ActionPhase) => void,
): Promise<void> {
  const { binding, bus, onActionResult } = deps;
  const { action, payload } = target;
  onPhase({ phase: "pending" });
  try {
    const res = (await binding.invokeAction(action, payload)) as ActionResult | null;
    const result = res?.result ?? null;
    onPhase({ phase: "succeeded", result });
    if (res?.invalidates != null && res.invalidates.length > 0) {
      bus.publish({
        refs: res.invalidates,
        ...(res.refVersions != null ? { refVersions: res.refVersions } : {}),
      });
    }
    onActionResult?.({ componentId: nodeId, action, phase: "succeeded", result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    onPhase({ phase: "failed", message });
    onActionResult?.({ componentId: nodeId, action, phase: "failed", message });
  }
}

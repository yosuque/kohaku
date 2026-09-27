import { type ActionPhase, resolveInvokeTarget, runInvokeTarget } from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject } from "@kohaku-ui/spec-core";
import { useState } from "react";
import { useEmitEvent, useMessages, useRenderer, useSpec } from "./context.js";
import { useDataInvalidation } from "./data-invalidation.js";
import { useRowContext } from "./spec-state.js";

/**
 * The default "confirm"-tier hook (design.md #62/#63) used when the host does not supply its own via
 * `RendererContextValue.confirm`: `globalThis.confirm` (the native browser dialog). Declines (returns
 * `false`) when `confirm` is unavailable in this environment (e.g. SSR) rather than throwing — the same
 * fail-safe posture as an explicitly declining host hook.
 */
function defaultConfirmHook(
  messages: { actionConfirmDefault: (action: string) => string },
  args: { action: string; message?: string },
): boolean {
  if (typeof globalThis.confirm !== "function") return false;
  return globalThis.confirm(args.message ?? messages.actionConfirmDefault(args.action));
}

// Progress state of a write (action.invoke). The framework-free source of truth is renderer-core;
// the public API (ActionPhase in index.ts) is kept unchanged via this re-export.
export type { ActionPhase };

export interface UseInvokeActionResult {
  state: ActionPhase;
  /** Resolves eventName's declared binding and executes it (the path branches by the emit kind). */
  invoke(eventName: string, runtime: JsonObject): Promise<void>;
}

/**
 * Write-execution hook from a component.
 * - When a declared binding's emit==="action.invoke" and a BindingClient is configured,
 *   the renderer (component) **directly executes** binding.invokeAction. On success, it publishes ActionResult.invalidates
 *   to the data invalidation bus, causing distant tables (useBoundData) to re-resolve in-place (the small loop).
 * - Otherwise (undeclared / intent.* / state.set / no BindingClient / unknown action name),
 *   it falls back to onEvent forwarding via useEmitEvent (the compatibility valve for phased migration; state stays idle).
 */
export function useInvokeAction(node: ComponentNode): UseInvokeActionResult {
  const emit = useEmitEvent(node);
  const { binding, onActionResult, actionManifest, confirm, requestApproval } = useRenderer();
  const messages = useMessages();
  const spec = useSpec();
  const bus = useDataInvalidation();
  const row = useRowContext();
  const [state, setState] = useState<ActionPhase>({ phase: "idle" });

  const invoke = async (eventName: string, runtime: JsonObject): Promise<void> => {
    // Whether direct execution is possible, the action name, and payload resolution have renderer-core's resolveInvokeTarget as the single source of truth
    // (deciding undeclared / emit kind / presence of binding / unknown action name, plus $row・$value + row-context payload resolution).
    const target = resolveInvokeTarget(spec, node, eventName, runtime, { hasBinding: binding != null, row });
    if (target.kind === "forward") {
      // Anything not meeting the conditions is delegated to the legacy path (onEvent forwarding).
      // useEmitEvent single-handedly handles undeclared discard, state.set's internal completion, and payload resolution.
      emit(eventName, runtime);
      return;
    }

    // binding is non-null at the point target.kind === "invoke" (resolveInvokeTarget has already checked hasBinding).
    // The preflightAction → (confirm/requestApproval hook) → pending → invokeAction →
    // succeeded/failed/invalid/awaitingApproval phase → bus.publish → onActionResult sequence has
    // renderer-core's runInvokeTarget as the single source of truth (shared with renderer-wc). `confirm`
    // defaults to `globalThis.confirm` (defaultConfirmHook) when the host does not supply its own;
    // `requestApproval` has no default (design.md #63 — no browser-native equivalent exists).
    await runInvokeTarget(
      target,
      {
        binding: binding!,
        bus,
        onActionResult,
        actionManifest,
        confirm: confirm ?? ((args) => defaultConfirmHook(messages, args)),
        requestApproval,
      },
      node.id,
      setState,
    );
  };

  return { state, invoke };
}

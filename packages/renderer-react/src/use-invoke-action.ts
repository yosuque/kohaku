import { type ActionPhase, resolveInvokeTarget, runInvokeTarget } from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject } from "@kohaku-ui/spec-core";
import { useState } from "react";
import { useEmitEvent, useRenderer, useSpec } from "./context.js";
import { useDataInvalidation } from "./data-invalidation.js";
import { useRowContext } from "./spec-state.js";

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
  const { binding, onActionResult } = useRenderer();
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
    // The pending → invokeAction → succeeded/failed phase → bus.publish → onActionResult sequence has
    // renderer-core's runInvokeTarget as the single source of truth (shared with renderer-wc).
    await runInvokeTarget(target, { binding: binding!, bus, onActionResult }, node.id, setState);
  };

  return { state, invoke };
}

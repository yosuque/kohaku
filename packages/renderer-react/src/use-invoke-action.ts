import {
  type ActionPhase,
  resolveInvokeTarget,
  runInvokeTarget,
  shouldPromptForApproval,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject } from "@kohaku-ui/spec-core";
import { useRef, useState } from "react";
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

/**
 * The default "approve"-tier hook (design.md #63/#72) used when the host does not supply its own via
 * `RendererContextValue.requestApproval`: a `globalThis.prompt` asking the requester to paste the approval
 * token an approver issued. It is consulted **only when the node is already in the "awaitingApproval" phase for
 * an "approve"-tier action** — the first click always reaches the server without a token, so the server records
 * `action.approvalRequested` (what the admin console's Approvals inbox lists) before anyone is asked for a
 * token. A cancelled or empty prompt, a missing `prompt` (SSR), and a throwing `prompt` (a sandboxed iframe
 * without `allow-modals`) all yield `undefined`: the invoke is sent without a token, exactly as before.
 */
function defaultRequestApprovalHook(
  messages: { actionApprovalPrompt: (action: string) => string },
  phase: ActionPhase,
  args: { action: string },
): string | undefined {
  if (!shouldPromptForApproval(phase)) return undefined;
  if (typeof globalThis.prompt !== "function") return undefined;
  try {
    const token = globalThis.prompt(messages.actionApprovalPrompt(args.action));
    const trimmed = token?.trim();
    return trimmed != null && trimmed !== "" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// Progress state of a write (action.invoke). The framework-free source of truth is renderer-core;
// the public API (ActionPhase in index.ts) is kept unchanged via this re-export.
export type { ActionPhase };

export interface UseInvokeActionResult {
  state: ActionPhase;
  /**
   * Resolves eventName's declared binding and executes it (the path branches by the emit kind).
   * `onPhase`, when given, is also called with every phase of a direct execution (never for the
   * forwarded path), for a caller that must react to how one particular invoke ended.
   */
  invoke(eventName: string, runtime: JsonObject, onPhase?: (phase: ActionPhase) => void): Promise<void>;
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
  // The node's latest phase, readable from inside an in-flight invoke (the default approval hook asks for a
  // token only when the previous attempt already ended in "awaitingApproval").
  const phaseRef = useRef<ActionPhase>(state);

  const invoke = async (
    eventName: string,
    runtime: JsonObject,
    onPhase?: (phase: ActionPhase) => void,
  ): Promise<void> => {
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
    // `requestApproval` defaults to `globalThis.prompt` once the node is awaiting approval
    // (defaultRequestApprovalHook, design.md #72).
    await runInvokeTarget(
      target,
      {
        binding: binding!,
        bus,
        onActionResult,
        actionManifest,
        confirm: confirm ?? ((args) => defaultConfirmHook(messages, args)),
        requestApproval:
          requestApproval ?? ((args) => defaultRequestApprovalHook(messages, phaseRef.current, args)),
      },
      node.id,
      (phase) => {
        phaseRef.current = phase;
        setState(phase);
        onPhase?.(phase);
      },
    );
  };

  return { state, invoke };
}

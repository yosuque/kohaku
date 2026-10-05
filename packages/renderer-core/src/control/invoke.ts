import { type ActionResult, type BindingClient, BindingError } from "@kohaku-ui/data-binding";
import {
  type ActionParamIssue,
  type ApprovalRequiredInfo,
  type ComponentNode,
  type JsonObject,
  resolveWriteActionName,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { RendererMessages } from "../messages.js";
import type { DataInvalidationBus } from "../stores/invalidation-bus.js";
import { type ActionManifest, preflightAction } from "./action-manifest.js";
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
 *
 * "invalid" and "awaitingApproval" (design.md #62/#63) are reached either locally, before any network
 * call, via `preflightAction` against `RunInvokeTargetDeps.actionManifest` (a pure UX shortcut), or from
 * the server's own response (`BindingError`'s `ACTION_PARAMS_INVALID` / `APPROVAL_REQUIRED` codes) when
 * no manifest entry was available to check locally, or the manifest is stale relative to the server's own
 * state. Neither is a "failed" write (nothing was committed either way, gated or rejected before commit),
 * so `onActionResult` (a completion notification) is not called for them -- only "succeeded" / "failed"
 * report there, unchanged from before these two phases existed.
 */
export type ActionPhase =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "succeeded"; result: unknown }
  | { phase: "failed"; message: string }
  | { phase: "invalid"; issues: ActionParamIssue[] }
  | {
      phase: "awaitingApproval";
      tier: "confirm" | "approve";
      message: string;
      /** The server-issued pending-approval descriptor, present only when this phase was reached from
       * the server's own APPROVAL_REQUIRED response (absent for a locally short-circuited preflight,
       * which never reaches the network). */
      approval?: ApprovalRequiredInfo;
    };

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
  /**
   * The compose-issued Action manifest (design.md #64), for a client-side `preflightAction` check before
   * the round trip. Absent -> no local check; the server remains authoritative and the same
   * "invalid" / "awaitingApproval" phases are still driven by its response instead.
   */
  actionManifest?: ActionManifest;
  /**
   * Confirmation hook for a "confirm"-tier action (design.md #62/#63), consulted only when
   * `preflightAction` (or, absent a manifest, a later server rejection -- see below) determines the
   * action needs one. Returning `true` (sync or async) retries the invoke with `confirmed: true`;
   * `false`/undefined leaves the action unexecuted, reporting phase "awaitingApproval" instead. When
   * unset, a "confirm"-tier action is never confirmed locally (renderer-react / renderer-wc default this
   * to `globalThis.confirm` when the host does not supply one -- see their own AttachOptions).
   */
  confirm?: (args: { action: string; message?: string }) => boolean | Promise<boolean>;
  /**
   * Approval-token hook for an "approve"-tier action (design.md #63), consulted the same way as
   * `confirm`. Returning a token (sync or async) retries the invoke with that `approval` token;
   * `undefined` (or an unset hook) still sends the invoke, without `approval`: the server records the
   * pending approval and answers APPROVAL_REQUIRED, reported as phase "awaitingApproval" carrying the
   * approval descriptor. This framework-free core supplies no default hook: the token is minted by an
   * approver (the host's `POST /approvals`, e.g. the admin console's Approvals tab, design.md #72) and
   * handed to the requester. renderer-react defaults the hook to a `globalThis.prompt` that is consulted
   * only once the node is already in the "awaitingApproval" phase for an "approve"-tier action, so the first
   * attempt still reaches the server and is recorded as a pending approval (renderer-wc has no default yet:
   * its host wires the hook itself).
   */
  requestApproval?: (args: {
    action: string;
    payload: JsonObject;
  }) => string | undefined | Promise<string | undefined>;
}

/**
 * Directly executes the write path decided by resolveInvokeTarget (kind === "invoke"):
 * preflightAction → (confirm/requestApproval hook, when the tier needs one) → pending →
 * binding.invokeAction → succeeded/failed/invalid/awaitingApproval phase →
 * bus.publish(invalidates) → onActionResult, in that exact order. The framework-free
 * source of truth for the sequence, avoiding duplicating it in renderer-react's
 * useInvokeAction and renderer-wc's tree.ts invokeAction. onPhase reports progress
 * (React's setState / WC's phase callback); nodeId identifies the component in
 * onActionResult.
 *
 * Governed actions (design.md #62/#63): `preflightAction` runs first, purely locally (no network call
 * yet). "invalid" short-circuits immediately (never attempts the invoke at all — a payload invalid on its
 * own terms should never even reach the tier gate, mirroring host-core's ActionGate order). "confirm"
 * consults `deps.confirm`; a hook that is unset, or that declines (returns false), short-circuits (phase
 * "awaitingApproval") without attempting the invoke. "approve" consults `deps.requestApproval` but never
 * short-circuits: without a token the invoke is still sent (no `approval`), so the server records
 * `action.approvalRequested` and returns the pending-approval descriptor. Only once the local gate is satisfied (or there was nothing to check — no manifest, or the
 * action's tier is "auto") does execution proceed to `binding.invokeAction`, whose own rejection is
 * additionally mapped: a `BindingError` with code `ACTION_PARAMS_INVALID` / `APPROVAL_REQUIRED` maps to
 * the same "invalid" / "awaitingApproval" phases (the server is always the final authority — a stale or
 * absent manifest just means this mapping happens after the round trip instead of before it).
 */
export async function runInvokeTarget(
  target: Extract<InvokeTarget, { kind: "invoke" }>,
  deps: RunInvokeTargetDeps,
  nodeId: string,
  onPhase: (phase: ActionPhase) => void,
): Promise<void> {
  const { binding, bus, onActionResult, actionManifest, confirm, requestApproval } = deps;
  const { action, payload } = target;

  const preflight = preflightAction(actionManifest, action, payload);
  if (preflight.kind === "invalid") {
    onPhase({ phase: "invalid", issues: preflight.issues });
    return;
  }

  let confirmed: boolean | undefined;
  let approval: string | undefined;
  if (preflight.kind === "confirm") {
    const ok = confirm != null ? await confirm({ action, message: preflight.confirmMessage }) : false;
    if (!ok) {
      onPhase({
        phase: "awaitingApproval",
        tier: "confirm",
        message: preflight.confirmMessage ?? "this action requires confirmation",
      });
      return;
    }
    confirmed = true;
  } else if (preflight.kind === "approve") {
    // No token obtained (no hook, or the hook declined): the request is still sent, without `approval`,
    // so the server records `action.approvalRequested` and answers 403 APPROVAL_REQUIRED with the
    // pending-approval descriptor (requestId / payloadHash) an approver needs. The catch below maps that
    // response to the "awaitingApproval" phase.
    const token = requestApproval != null ? await requestApproval({ action, payload }) : undefined;
    if (token != null) approval = token;
  }

  onPhase({ phase: "pending" });
  try {
    const res = (await binding.invokeAction(action, payload, { confirmed, approval })) as ActionResult | null;
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
    if (e instanceof BindingError && e.code === "ACTION_PARAMS_INVALID") {
      onPhase({ phase: "invalid", issues: e.issues ?? [] });
      return;
    }
    if (e instanceof BindingError && e.code === "APPROVAL_REQUIRED") {
      onPhase({
        phase: "awaitingApproval",
        tier: e.approval?.tier ?? "confirm",
        message: e.message,
        approval: e.approval,
      });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    onPhase({ phase: "failed", message });
    onActionResult?.({ componentId: nodeId, action, phase: "failed", message });
  }
}

/**
 * A visible notice for the two governed-action phases that stop an action before it commits
 * ("invalid" / "awaitingApproval", design.md #62/#63/#64), or `null` for every other phase. The single
 * source of truth for both renderers: `role` is `"alert"` for a rejection (interrupting) and `"status"`
 * for a wait (non-interrupting), matching how a form reports "failed" / "succeeded".
 */
export interface ActionPhaseNotice {
  role: "alert" | "status";
  text: string;
}

/**
 * Whether a renderer's default approval hook should ask the requester for a token now: only when the node's
 * previous attempt already ended in the "awaitingApproval" phase for an `"approve"`-tier action. The first
 * attempt always reaches the server without a token, so the server records `action.approvalRequested` (what
 * the Approvals inbox lists) before anyone is prompted. `undefined` (no phase observed yet) is `false`.
 */
export function shouldPromptForApproval(phase: ActionPhase | undefined): boolean {
  return phase?.phase === "awaitingApproval" && phase.tier === "approve";
}

/**
 * The payload hash as shown to a person: the hex digest without its `sha256:` prefix, cut to its first 12
 * characters. The single source of truth for the requester's notice (`actionAwaitingApprovalDetail`) and the
 * admin console's Approvals row, so both show the same short form of the same hash.
 */
export function shortPayloadHash(payloadHash: string): string {
  return payloadHash.replace(/^sha256:/, "").slice(0, 12);
}

/** Derives the {@link ActionPhaseNotice} for a phase (localized through `messages`), or `null` when it needs none. */
export function actionPhaseNotice(phase: ActionPhase, messages: RendererMessages): ActionPhaseNotice | null {
  switch (phase.phase) {
    case "invalid":
      return { role: "alert", text: messages.actionInvalid(phase.issues.length) };
    case "awaitingApproval": {
      const base = messages.actionAwaiting(phase.tier);
      // The server's descriptor (absent for a locally short-circuited preflight) lets the requester name the
      // request to an approver; the Approvals inbox lists the same requestId / payload hash.
      const text =
        phase.approval != null
          ? `${base} (${messages.actionAwaitingApprovalDetail(phase.approval.requestId, shortPayloadHash(phase.approval.payloadHash))})`
          : base;
      return { role: "status", text };
    }
    default:
      return null;
  }
}

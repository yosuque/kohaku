import type { ActionParamIssue, ApprovalRequiredInfo, JsonObject, Principal } from "@kohaku-ui/spec-core";
import { actionPayloadHash } from "@kohaku-ui/spec-core";
import type { ActionAuditRecorder } from "./action-audit.js";
import type { ActionGateResult } from "./action-gate.js";
import { failOpen } from "./errors.js";

/**
 * An action name absent from the DomainPort's own operation index is not a declared operation at all --
 * it must never reach `domain.invoke` (fail-closed), on the same footing as a capability that lacks the
 * needed write scope (both hosts reuse that response shape rather than minting a new error code: REST's
 * 403 CAPABILITY_DENIED, MCP's plain `capability denied: ...` tool error).
 */
export const UNDECLARED_ACTION_MESSAGE = "action is not a declared DomainPort operation";

/** Client-visible message for a `"confirm"`-tier action invoked without `confirmed: true`. */
export const CONFIRMATION_REQUIRED_MESSAGE = "this action requires confirmation (confirmed: true)";

/** Client-visible message for an `"approve"`-tier action invoked without an approval token. */
export const APPROVAL_TOKEN_REQUIRED_MESSAGE = "this action requires an approval token";

/** The audit context both `recordActionGateResult` and `recordUndeclaredActionDenial` need. */
export interface ActionAuditContext {
  /** `undefined` = no audit recording (a host that wires no `ActionAuditRecorder`). */
  recorder: ActionAuditRecorder | undefined;
  action: string;
  payload: JsonObject;
  principal: Principal;
  /** Omitted by a profile that resolves no tenant (MCP). */
  tenant?: string;
  correlationId: string;
  /** Reports a recording failure to the host's observability hook; must not reject. */
  report: (error: unknown) => Promise<void>;
}

/**
 * What a host maps onto its own wire after `recordActionGateResult` has audited one `ActionGate.check`
 * outcome (REST: 422 / 403; MCP: a structured tool error). The gate's `approvalRequired` and `denied`
 * results both surface as the same `APPROVAL_REQUIRED` wire error (they differ only in the audit event
 * recorded and in `message`), so they collapse to one variant here.
 */
export type ActionGateOutcome =
  /** The payload failed params validation. Wire: 422 `ACTION_PARAMS_INVALID` carrying `issues`. */
  | { kind: "invalid"; issues: ActionParamIssue[] }
  /** The tier gate was not satisfied. Wire: 403 `APPROVAL_REQUIRED` carrying `message` and `approval`. */
  | { kind: "approvalRequired"; message: string; approval: ApprovalRequiredInfo }
  /** The gate allowed the invoke: the caller proceeds to `DomainPort.invoke`. */
  | { kind: "proceed" };

/**
 * The audit trail for one `ActionGate.check` outcome (design.md #62/#63; SPEC LIN-ACT-001), shared by both
 * host profiles so REST and MCP record identical `action.*` events for the same gate result: `invalid`
 * records nothing, `approvalRequired` records `action.approvalRequested`, `denied` records `action.denied`,
 * and `allow` records `action.invoked` (plus `action.approved` when a grant was consumed). Recording is
 * always fail-open (`failOpen`): a recording failure must never turn an otherwise-successful allow, or an
 * otherwise-correct denial, into an unhandled failure. Each host keeps only its own wire mapping of the
 * returned `ActionGateOutcome`.
 */
export async function recordActionGateResult(
  gateResult: ActionGateResult,
  ctx: ActionAuditContext,
): Promise<ActionGateOutcome> {
  const { recorder, action, payload, principal, correlationId, report } = ctx;
  const tenant = ctx.tenant != null ? { tenant: ctx.tenant } : {};

  switch (gateResult.kind) {
    case "invalid":
      return { kind: "invalid", issues: gateResult.issues };

    case "approvalRequired":
      await failOpen(async () => {
        await recorder?.approvalRequested({
          action,
          payloadHash: gateResult.payloadHash,
          tier: gateResult.tier,
          requestId: gateResult.requestId,
          payload,
          principal,
          ...tenant,
          correlationId,
        });
      }, report);
      return {
        kind: "approvalRequired",
        message:
          gateResult.tier === "confirm" ? CONFIRMATION_REQUIRED_MESSAGE : APPROVAL_TOKEN_REQUIRED_MESSAGE,
        approval: {
          requestId: gateResult.requestId,
          action,
          tier: gateResult.tier,
          payloadHash: gateResult.payloadHash,
        },
      };

    case "denied":
      await failOpen(async () => {
        await recorder?.denied({
          action,
          payloadHash: gateResult.payloadHash,
          tier: gateResult.tier,
          reason: gateResult.reason,
          principal,
          ...tenant,
          correlationId,
        });
      }, report);
      return {
        kind: "approvalRequired",
        message: gateResult.reason,
        approval: {
          requestId: gateResult.requestId,
          action,
          tier: gateResult.tier,
          payloadHash: gateResult.payloadHash,
        },
      };

    case "allow":
      await failOpen(async () => {
        await recorder?.invoked({
          action,
          payloadHash: gateResult.payloadHash,
          tier: gateResult.tier,
          principal,
          ...tenant,
          correlationId,
        });
        if (gateResult.grant != null) {
          await recorder?.approved({
            action,
            payloadHash: gateResult.payloadHash,
            grant: gateResult.grant,
            principal,
            ...tenant,
            correlationId,
          });
        }
      }, report);
      return { kind: "proceed" };
  }
}

/**
 * Records `action.denied` (tier `"auto"`: no governed-action tier applies to a name that was never a real
 * operation) for an action name absent from the DomainPort's operation index -- the fail-closed rejection
 * both hosts perform before the gate ever runs (SPEC ACT-PRM-001, MCPAPP-ACT-001; audit per LIN-ACT-001).
 * Fail-open like `recordActionGateResult`. The host then answers with `UNDECLARED_ACTION_MESSAGE`.
 */
export async function recordUndeclaredActionDenial(ctx: ActionAuditContext): Promise<void> {
  const { recorder, action, payload, principal, correlationId, report } = ctx;
  await failOpen(async () => {
    await recorder?.denied({
      action,
      payloadHash: await actionPayloadHash(payload),
      tier: "auto",
      reason: UNDECLARED_ACTION_MESSAGE,
      principal,
      ...(ctx.tenant != null ? { tenant: ctx.tenant } : {}),
      correlationId,
    });
  }, report);
}

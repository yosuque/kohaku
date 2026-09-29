import type { ActionTier, ApprovalGrant, JsonObject, Principal } from "@kohaku-ui/spec-core";

/**
 * Audit-recording hooks for governed Actions (design.md #62/#63; `@kohaku-ui/lineage`'s
 * `createActionAuditRecorder` supplies the implementation, backed by its `action.*` event family --
 * no recording happens if a host does not wire one). Mirrors `ViewRecorder`'s role: the interface lives
 * here (host-core) so both host profiles (REST's `KohakuHostDeps` and MCP's `McpHostDeps`) can depend on
 * the same contract without either depending on `@kohaku-ui/lineage` directly (same-layer siblings must
 * not depend on one another -- see AGENTS.md's dependency direction).
 *
 * Every method records unconditionally whatever it is given; a caller (a REST/MCP route) wraps each call
 * in its own fail-open handling (host-core's `failOpen`) the same way `recordComposedResult` already does
 * for `ViewRecorder` -- a recording failure must never take down an otherwise-successful (or
 * otherwise-denied) action response.
 */
export interface ActionAuditRecorder {
  /**
   * Records that the gate allowed an invoke (the `ActionGate` returned `allow`), never the payload
   * itself. It means "allowed by the gate", not "the write succeeded": a caller records it before
   * `DomainPort.invoke` runs, and an `"approve"` token has already been consumed by then (SPEC LIN-ACT-001).
   */
  invoked(args: {
    action: string;
    payloadHash: string;
    tier: ActionTier;
    principal: Principal;
    tenant?: string;
    correlationId?: string;
  }): Promise<void>;
  /**
   * Records a denied invoke attempt: either the `ActionGate` returned `denied` (an `"approve"`-tier
   * token was presented but did not verify, or no `ApprovalPort` is configured at all -- `tier` is
   * `"confirm"` or `"approve"` for these), or the action name was rejected before the gate ever ran
   * because it is not one of the `DomainPort`'s own declared operations (`tier` is `"auto"` here -- no
   * governed-action tier applies to a name that was never a real operation to begin with).
   */
  denied(args: {
    action: string;
    payloadHash: string;
    tier: ActionTier;
    reason: string;
    principal: Principal;
    tenant?: string;
    correlationId?: string;
  }): Promise<void>;
  /**
   * Records that an approval/confirmation is now pending (the `ActionGate` returned `approvalRequested`:
   * nothing was presented yet). `payload` is always passed here; whether it is actually persisted (versus
   * only its hash) is the concrete recorder's own configuration (`createActionAuditRecorder`'s
   * `recordPayload` option), not a decision this call site makes.
   */
  approvalRequested(args: {
    action: string;
    payloadHash: string;
    tier: "confirm" | "approve";
    requestId: string;
    payload: JsonObject;
    principal: Principal;
    tenant?: string;
    correlationId?: string;
  }): Promise<void>;
  /**
   * Records that an approval grant was successfully consumed (the `ActionGate` returned `allow` with a
   * `grant`, i.e. tier `"approve"`). Recorded in addition to (not instead of) `invoked` for the same
   * request.
   */
  approved(args: {
    action: string;
    payloadHash: string;
    grant: ApprovalGrant;
    principal: Principal;
    tenant?: string;
    correlationId?: string;
  }): Promise<void>;
}

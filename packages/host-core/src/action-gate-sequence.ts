import type { ActionParamIssue, ActionTier } from "@kohaku-ui/spec-core";
import type { ActionGate, ActionGateResult } from "./action-gate.js";
import {
  type ActionAuditContext,
  type ActionGateOutcome,
  recordActionGateResult,
  recordActionGateUnavailableDenial,
  recordUndeclaredActionDenial,
} from "./action-gate-outcome.js";
import type { OperationIndex, OperationIndexEntry } from "./operation-index.js";

/** What `runActionGate` needs from one host for one governed-action invoke attempt. */
export interface RunActionGateInput {
  /**
   * Reads the DomainPort's operation index. A throw (or a rejection) is the `indexUnavailable` outcome; it is
   * called exactly once, first.
   */
  operationIndex: () => ReturnType<OperationIndex>;
  /** The gate consulted once the action is a declared, valid operation. */
  gate: ActionGate;
  /**
   * The audit context for every audit site of the sequence. It also supplies what the gate request needs:
   * `action` is the operation looked up and gated, `payload` the payload checked, `principal.id` the
   * requester bound into an approval, and `tenant` the tenant passed to `gate.check` -- exactly the value
   * the audit records carry, so a profile that resolves no tenant (MCP) omits it here and the gate never
   * sees one; this function never invents a tenant.
   */
  audit: ActionAuditContext;
  /**
   * The audit context used for the undeclared-action denial alone (REST passes none; MCP overrides `report`
   * there so that record carries the call's correlation id). Defaults to `audit`.
   */
  undeclaredAudit?: ActionAuditContext;
  /** The request's `confirmed` field (tier `"confirm"`), passed to `gate.check` as given. */
  confirmed?: boolean | undefined;
  /** The request's `approval` token (tier `"approve"`), passed to `gate.check` as given. */
  approval?: string | undefined;
  /**
   * The unsafe-key issues of the *raw* payload (SPEC ACT-PRM-001: the parsed copy may already have lost an
   * own `__proto__` key). Evaluated after the entry checks and before the gate; a non-empty result is the
   * gate's own `invalid` outcome and `gate.check` is not called. REST scans the raw body lazily here; MCP
   * passes the array it computed while validating the tool input.
   */
  unsafeKeyIssues: () => ActionParamIssue[] | Promise<ActionParamIssue[]>;
  /**
   * The host's observability-hook reports, one per failure site (each host owns its endpoint names and
   * correlation-id passing). Each is awaited BEFORE the matching audit record is written, and must not reject.
   */
  report: {
    /** The operation index could not be read. */
    indexFailure: (error: unknown) => Promise<void>;
    /** The declared operation's `paramsSchema` failed validation (`OperationIndexEntry.schemaError`). */
    schemaError: (error: unknown) => Promise<void>;
    /** `gate.check` threw (e.g. the ApprovalPort was unreachable). */
    gateFailure: (error: unknown) => Promise<void>;
  };
}

/**
 * How one governed-action attempt resolved, for the host to map onto its own wire (REST: 503 / 403 / 500 / 422;
 * MCP: a tool error). By the time it is returned, every report and audit record the sequence owns has already
 * been made; the host only maps and, on `proceed`, invokes the DomainPort.
 */
export type ActionGateSequenceOutcome =
  /** The operation index could not be read; reported, and audited as `action.denied` (tier `"auto"`). */
  | { kind: "indexUnavailable" }
  /** The action is not in the operation index; audited as `action.denied` (tier `"auto"`). */
  | { kind: "undeclared" }
  /** The declared operation's `paramsSchema` is invalid; reported only (nothing is audited). */
  | { kind: "schemaInvalid" }
  /** `gate.check` threw; reported, and audited as `action.denied` with `tier` (the descriptor's, `"auto"` if unset). */
  | { kind: "gateUnavailable"; tier: ActionTier }
  /** `recordActionGateResult`'s `invalid` / `approvalRequired` outcomes, passed through unchanged. */
  | Extract<ActionGateOutcome, { kind: "invalid" | "approvalRequired" }>
  /** The gate allowed the invoke (already audited as `action.invoked` / `action.approved`); `entry` is the declared operation. */
  | { kind: "proceed"; entry: OperationIndexEntry };

/**
 * The governed-action gate sequence both host profiles run before `DomainPort.invoke` (design.md #62/#63;
 * SPEC ACT-PRM-001, ACT-APR-001, LIN-ACT-001), as one pure sequence that returns an outcome instead of a wire
 * response -- the `proceed`-or-refuse counterpart of what `composeWithFixation` is for the compose path:
 *
 * 1. read the operation index (a throw: report, then audit `action.denied` without a tier);
 * 2. look the action up: absent -> audit `action.denied` (undeclared); present with a `schemaError` -> report;
 *    (the two are mutually exclusive, so which is checked first is immaterial);
 * 3. scan the raw payload for unsafe keys; any -> the gate's `invalid` outcome, `gate.check` is skipped;
 *    otherwise `gate.check` (a throw: report, then audit `action.denied` with the descriptor's tier);
 * 4. audit the gate result via `recordActionGateResult` and return its outcome.
 *
 * Reports precede the matching audit record, and every audit record is fail-open (see the recorders in
 * `action-gate-outcome.ts`), exactly as each host did inline before. What differs per host -- the wire
 * mapping, the observability endpoint names, the tenant -- stays with the host.
 */
export async function runActionGate(input: RunActionGateInput): Promise<ActionGateSequenceOutcome> {
  const { audit, gate, report } = input;

  let index: Awaited<ReturnType<OperationIndex>>;
  try {
    index = await input.operationIndex();
  } catch (e) {
    await report.indexFailure(e);
    await recordActionGateUnavailableDenial(audit);
    return { kind: "indexUnavailable" };
  }
  const entry = index.get(audit.action);
  if (entry == null) {
    await recordUndeclaredActionDenial(input.undeclaredAudit ?? audit);
    return { kind: "undeclared" };
  }
  // A declared operation whose paramsSchema failed validation must never be invoked: fail closed for this
  // operation alone.
  if (entry.schemaError != null) {
    await report.schemaError(entry.schemaError);
    return { kind: "schemaInvalid" };
  }

  let gateResult: ActionGateResult;
  const unsafeKeyIssues = await input.unsafeKeyIssues();
  if (unsafeKeyIssues.length > 0) {
    gateResult = { kind: "invalid", issues: unsafeKeyIssues };
  } else {
    try {
      gateResult = await gate.check({
        descriptor: entry.descriptor,
        paramsSchema: entry.paramsSchema,
        payload: audit.payload,
        confirmed: input.confirmed,
        approval: input.approval,
        requesterId: audit.principal.id,
        ...(audit.tenant != null ? { tenant: audit.tenant } : {}),
      });
    } catch (e) {
      // The gate could not decide: a denial, never an unhandled failure that skips the audit trail.
      const tier = entry.descriptor.tier ?? "auto";
      await report.gateFailure(e);
      await recordActionGateUnavailableDenial({ ...audit, tier });
      return { kind: "gateUnavailable", tier };
    }
  }

  const outcome = await recordActionGateResult(gateResult, audit);
  return outcome.kind === "proceed" ? { kind: "proceed", entry } : outcome;
}

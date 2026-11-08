import { actionPayloadHash } from "@kohaku-ui/spec-core";
import { type ActionAuditContext, recordActionGateUnavailableDenial } from "./action-gate-outcome.js";
import { failOpen } from "./errors.js";
import type { OperationIndex, OperationIndexEntry } from "./operation-index.js";

/**
 * Client-visible message (and `action.denied` audit reason) when a data-plane read names an operation whose
 * declared tier is `"confirm"` or `"approve"` (SPEC ACT-RD-001, design.md #77). Fixed on purpose, like the
 * other action-gate messages: REST answers 403 `CAPABILITY_DENIED`, MCP a plain `capability denied: ...` tool error.
 */
export const GATED_READ_MESSAGE = "gated operation is not readable";

/**
 * True when `entry` is a governed Action that must go through the action gate (a declared tier of `"confirm"`
 * or `"approve"`). A tier-less operation and tier `"auto"` are not gated. The read paths use this on the
 * operation a `query://` ref names, so a read capability can never run a write that the gate would have held for a
 * confirmation or an approval (SPEC ACT-RD-001).
 */
export function isGatedOperation(entry: OperationIndexEntry): boolean {
  const tier = entry.descriptor.tier;
  return tier === "confirm" || tier === "approve";
}

/** What `runGatedReadGuard` needs from one host for one data-plane read of a single ref. */
export interface RunGatedReadGuardInput {
  /** Reads the DomainPort's operation index (memoized by the host). A throw is the `indexUnavailable` outcome. */
  operationIndex: () => ReturnType<OperationIndex>;
  /**
   * The audit context: `action` is the operation the ref names (`parsed.base.path`), `payload` the invoke
   * params. Only used for the `action.denied` record of a refused read.
   */
  audit: ActionAuditContext;
  /** Reports an unreadable operation index to the host's observability hook; awaited before the audit record, must not reject. */
  reportIndexFailure: (error: unknown) => Promise<void>;
}

/**
 * How one data-plane read resolved against the guard, for the host to map onto its own wire (REST: 403 / 503;
 * MCP: a tool error). By the time it is returned, the report and audit record the guard owns have been made.
 */
export type GatedReadOutcome =
  /** The operation is not gated (or is not in the index at all, as before): the host may invoke it. */
  | { kind: "readable" }
  /** The operation is gated; audited as `action.denied` with the descriptor's tier. The host must not invoke. */
  | { kind: "gated"; tier: "confirm" | "approve" }
  /** The operation index could not be read: reported, audited as `action.denied` (tier `"auto"`). The host must not invoke (fail-closed). */
  | { kind: "indexUnavailable" };

/**
 * The guard every data-plane read runs before `DomainPort.invoke` (REST `/binding/resolve`, MCP
 * `${prefix}_resolve_binding`, MCP initial-data pre-resolution; SPEC ACT-RD-001): look the ref's operation up in
 * the memoized operation index and refuse it when it is gated. Fail-closed when the index cannot be read, on the
 * same footing as the action path's `runActionGate` (SPEC ACT-APR-001). An operation absent from the index
 * stays readable -- read refs name query operations that a `DomainPort` need not list, and nothing there
 * declares a tier to enforce. The audit records are fail-open, like every recorder in `action-gate-outcome.ts`.
 */
export async function runGatedReadGuard(input: RunGatedReadGuardInput): Promise<GatedReadOutcome> {
  const { audit } = input;
  let index: Awaited<ReturnType<OperationIndex>>;
  try {
    index = await input.operationIndex();
  } catch (e) {
    await input.reportIndexFailure(e);
    await recordActionGateUnavailableDenial(audit);
    return { kind: "indexUnavailable" };
  }
  const entry = index.get(audit.action);
  if (entry == null || !isGatedOperation(entry)) return { kind: "readable" };
  const tier = entry.descriptor.tier as "confirm" | "approve";
  await recordGatedReadDenial({ ...audit, tier });
  return { kind: "gated", tier };
}

/**
 * Records `action.denied` for a data-plane read refused because the ref names a gated operation (reason
 * `GATED_READ_MESSAGE`, tier = the descriptor's). Fail-open like the other recorders in `action-gate-outcome.ts`.
 */
async function recordGatedReadDenial(
  ctx: ActionAuditContext & { tier: "confirm" | "approve" },
): Promise<void> {
  const { recorder, action, payload, principal, correlationId, report } = ctx;
  await failOpen(async () => {
    await recorder?.denied({
      action,
      payloadHash: await actionPayloadHash(payload),
      tier: ctx.tier,
      reason: GATED_READ_MESSAGE,
      principal,
      ...(ctx.tenant != null ? { tenant: ctx.tenant } : {}),
      correlationId,
    });
  }, report);
}

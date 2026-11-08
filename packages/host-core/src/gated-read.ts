import type { OperationDescriptor } from "@kohaku-ui/spec-core";
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

/** An index entry whose descriptor declares tier `"confirm"` or `"approve"`. */
export type GatedOperationEntry = OperationIndexEntry & {
  descriptor: OperationDescriptor & { tier: "confirm" | "approve" };
};

/**
 * True when `entry` is a governed Action that must go through the action gate (a declared tier of `"confirm"`
 * or `"approve"`). A tier-less operation and tier `"auto"` are not gated. The read paths use this on the
 * operation a `query://` ref names, so a read capability can never run a write that the gate would have held for a
 * confirmation or an approval (SPEC ACT-RD-001).
 */
export function isGatedOperation(entry: OperationIndexEntry): entry is GatedOperationEntry {
  const tier = entry.descriptor.tier;
  return tier === "confirm" || tier === "approve";
}

/**
 * How one data-plane read resolved against the guard, for the host to map onto its own wire (REST: 403 / 500 /
 * 503; MCP: a tool error). By the time it is returned, the report and audit record the guard owns have been made.
 */
export type GatedReadOutcome =
  /** The operation is not gated (or is not in the index at all, as before): the host may invoke it. */
  | { kind: "readable" }
  /** The operation is gated; audited as `action.denied` with the descriptor's tier. The host must not invoke. */
  | { kind: "gated"; tier: "confirm" | "approve" }
  /**
   * The operation is declared but its `paramsSchema` failed validation (`OperationIndexEntry.schemaError`);
   * reported only, like the action path (nothing is audited). The host must not invoke (fail-closed for this
   * operation alone).
   */
  | { kind: "schemaInvalid" }
  /**
   * The operation index could not be read: reported and audited as `action.denied` (tier `"auto"`) by the first
   * read of this guard only. The host must not invoke (fail-closed).
   */
  | { kind: "indexUnavailable" };

/** What `createGatedReadGuard` needs from one host. */
export interface GatedReadGuardInput {
  /**
   * Reads the DomainPort's operation index (memoized by the host). It is called at most once per guard, so
   * several reads sharing one guard (an initial-data pre-resolution) share one read of the index, and one
   * failure.
   */
  operationIndex: () => ReturnType<OperationIndex>;
  /** The host's observability-hook reports; each is awaited BEFORE the matching audit record and must not reject. */
  report: {
    /** The operation index could not be read (reported once per guard). */
    indexFailure: (error: unknown) => Promise<void>;
    /** The declared operation's `paramsSchema` failed validation (reported once per guard and operation). */
    schemaError: (error: unknown) => Promise<void>;
  };
}

/**
 * Checks one read of `operation` (the op name a `query://` ref's path names, passed explicitly -- never taken
 * from `audit.action`, which is overwritten with it). `audit` supplies the principal, tenant, recorder and
 * correlation id for the `action.denied` record and `payload` the invoke params it is hashed from.
 */
export type GatedReadGuard = (operation: string, audit: ActionAuditContext) => Promise<GatedReadOutcome>;

/**
 * Builds the guard every data-plane read runs before `DomainPort.invoke` (REST `/binding/resolve`, MCP
 * `${prefix}_resolve_binding`, MCP initial-data pre-resolution; SPEC ACT-RD-001): look the ref's operation up in
 * the memoized operation index and refuse it when it is gated. Fail-closed when the index cannot be read, on the
 * same footing as the action path's `runActionGate` (SPEC ACT-APR-001), and when the operation's declaration is
 * invalid (`schemaError`, the action path's `schemaInvalid`); a gated operation is refused as such even when its
 * schema is invalid. An operation absent from the index stays readable -- read refs name query operations that a
 * `DomainPort` need not list, and nothing there declares a tier to enforce. The audit records are fail-open, like
 * every recorder in `action-gate-outcome.ts`.
 *
 * One guard reads the index once: if that read fails, the first read through the guard reports it and audits
 * `action.denied` (tier `"auto"`), and every other read through the same guard gets `indexUnavailable` silently,
 * so a pre-resolution of N refs over a dead `listOperations()` yields one report and one audit record, not N.
 */
export function createGatedReadGuard(input: GatedReadGuardInput): GatedReadGuard {
  let indexRead: Promise<Awaited<ReturnType<OperationIndex>>> | undefined;
  let indexFailureHandled = false;
  const schemaErrorsReported = new Set<string>();
  return async (operation, audit) => {
    const ctx: ActionAuditContext = { ...audit, action: operation };
    indexRead ??= input.operationIndex();
    let index: Awaited<ReturnType<OperationIndex>>;
    try {
      index = await indexRead;
    } catch (e) {
      if (!indexFailureHandled) {
        indexFailureHandled = true;
        await input.report.indexFailure(e);
        await recordActionGateUnavailableDenial(ctx);
      }
      return { kind: "indexUnavailable" };
    }
    const entry = index.get(operation);
    if (entry == null) return { kind: "readable" };
    if (isGatedOperation(entry)) {
      const tier = entry.descriptor.tier;
      await recordGatedReadDenial(ctx, tier);
      return { kind: "gated", tier };
    }
    if (entry.schemaError != null) {
      if (!schemaErrorsReported.has(operation)) {
        schemaErrorsReported.add(operation);
        await input.report.schemaError(entry.schemaError);
      }
      return { kind: "schemaInvalid" };
    }
    return { kind: "readable" };
  };
}

/** What `runGatedReadGuard` needs from one host for one data-plane read of a single ref. */
export interface RunGatedReadGuardInput extends GatedReadGuardInput {
  /** The operation the ref names (`parsed.base.path`). */
  operation: string;
  /** The audit context; `payload` is the invoke params. Its `action` is overwritten with `operation`. */
  audit: ActionAuditContext;
}

/** The one-shot form of `createGatedReadGuard`, for a host that reads a single ref per request. */
export function runGatedReadGuard(input: RunGatedReadGuardInput): Promise<GatedReadOutcome> {
  return createGatedReadGuard(input)(input.operation, input.audit);
}

/**
 * Records `action.denied` for a data-plane read refused because the ref names a gated operation (reason
 * `GATED_READ_MESSAGE`, tier = the descriptor's). Fail-open like the other recorders in `action-gate-outcome.ts`.
 */
async function recordGatedReadDenial(ctx: ActionAuditContext, tier: "confirm" | "approve"): Promise<void> {
  const { recorder, action, payload, principal, correlationId, report } = ctx;
  await failOpen(async () => {
    await recorder?.denied({
      action,
      payloadHash: await actionPayloadHash(payload),
      tier,
      reason: GATED_READ_MESSAGE,
      principal,
      ...(ctx.tenant != null ? { tenant: ctx.tenant } : {}),
      correlationId,
    });
  }, report);
}

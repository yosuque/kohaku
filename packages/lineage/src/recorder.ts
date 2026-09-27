import {
  type ActionTier,
  type ApprovalGrant,
  computeSpecHash,
  type JsonObject,
  type Principal,
  type Surface,
  type UISpec,
} from "@kohaku-ui/spec-core";
import type { ComposeTraceLike, Lineage } from "./lineage.js";

/**
 * Adapter conforming to host-rest's ViewRecorder interface.
 * Automatically records the REST surface's compose / events / telemetry into View Lineage.
 */
export interface RestViewRecorder {
  composed(args: {
    spec: UISpec;
    trace: ComposeTraceLike;
    surface: Surface;
    sessionId?: string;
    tenant?: string;
    /** Precomputed hash. If passed, viewComposed does not re-hash the Spec. Unset means internal computation (backward compatible). */
    specHash?: string;
    structureHash?: string;
  }): Promise<void>;
  interacted(args: {
    intentHash: string;
    componentId: string;
    on: string;
    payload: JsonObject;
    surface: Surface;
    sessionId?: string;
    tenant?: string;
  }): Promise<void>;
  rendered?(args: {
    specHash: string;
    surface: Surface;
    renderer: string;
    durationMs?: number;
    tenant?: string;
  }): Promise<void>;
  componentUsed?(args: {
    artifactId: string;
    surface: Surface;
    outcome: "ok" | "error";
    sessionId?: string;
    tenant?: string;
  }): Promise<void>;
  fallback?(args: {
    spec: UISpec;
    reason: string;
    kind: "generation" | "negotiation";
    surface: Surface;
    sessionId?: string;
    tenant?: string;
    /** Precomputed hash. If passed, does not re-hash the Spec. Unset means internal computation (backward compatible). */
    specHash?: string;
    /** The compose trace's correlation id (see ComposeTraceLike's doc comment / lineage.ts's ViewComposedPayload.correlationId). */
    correlationId?: string;
  }): Promise<void>;
}

export function createViewRecorder(lineage: Lineage): RestViewRecorder {
  return {
    async composed(args) {
      await lineage.viewComposed(args);
    },
    async interacted(args) {
      await lineage.viewInteracted(args);
    },
    async rendered(args) {
      await lineage.viewRendered(args);
    },
    async componentUsed(args) {
      // Actual-render observation via telemetry. Stamps source so it can be distinguished from the compose-time record (excluded from promotion aggregation).
      await lineage.componentUsed({ ...args, source: "telemetry" });
    },
    async fallback(args) {
      // Derive specHash / intentHash from spec and record view.fallback.
      // Makes the occurrence rate (L1/L2 failures, capability downgrade) observable from lineage.
      // If the caller already computed it (host-rest's deliverComposed shares one computation across
      // recordComposed and recordFallbackIfAny), reuse it instead of hashing the same Spec again.
      const specHash = args.specHash ?? (await computeSpecHash(args.spec));
      await lineage.viewFallback({
        specHash,
        reason: args.reason,
        surface: args.surface,
        kind: args.kind,
        intentHash: args.spec.intent.hash,
        ...(args.sessionId != null ? { sessionId: args.sessionId } : {}),
        ...(args.tenant != null ? { tenant: args.tenant } : {}),
        ...(args.correlationId != null ? { correlationId: args.correlationId } : {}),
      });
    },
  };
}

/**
 * Adapter conforming to host-core's `ActionAuditRecorder` interface (design.md #62/#63) -- structurally
 * duplicated here rather than imported, the same reason `RestViewRecorder` duplicates `ViewRecorder`
 * above: `@kohaku-ui/lineage` does not depend on `@kohaku-ui/host-core` (see this package's
 * dependency-free-leaf-on-spec-core convention noted throughout this file), so it cannot reference that
 * type by name even though the dependency *direction* would otherwise allow it.
 */
export interface RestActionAuditRecorder {
  invoked(args: {
    action: string;
    payloadHash: string;
    tier: ActionTier;
    principal: Principal;
    tenant?: string;
    correlationId?: string;
  }): Promise<void>;
  denied(args: {
    action: string;
    payloadHash: string;
    tier: ActionTier;
    reason: string;
    principal: Principal;
    tenant?: string;
    correlationId?: string;
  }): Promise<void>;
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
  approved(args: {
    action: string;
    payloadHash: string;
    grant: ApprovalGrant;
    principal: Principal;
    tenant?: string;
    correlationId?: string;
  }): Promise<void>;
}

export interface CreateActionAuditRecorderOptions {
  /**
   * When true, `approvalRequested` persists the raw invoke payload (not just its hash) on the
   * `action.approvalRequested` event -- see `ActionApprovalRequestedPayload`'s doc comment for why an
   * operator would opt into this (an approver-facing flow needing to see the actual content, e.g. an
   * `annotate` action's note text, rather than just its hash). Default false.
   */
  recordPayload?: boolean;
}

/**
 * Builds the `ActionAuditRecorder` implementation backed by `lineage`'s `action.*` event family. Every
 * event is recorded with actor `{ kind: "user", id: principal.id }` -- the principal that made the
 * invoke request, whether or not that specific attempt was allowed, denied, or left pending (an approval
 * decision itself, once made, is out of scope for this recorder: `action.approved` records *that* a
 * given grant was consumed by this invoke, not the separate act of the approver having issued it).
 */
export function createActionAuditRecorder(
  lineage: Lineage,
  options: CreateActionAuditRecorderOptions = {},
): RestActionAuditRecorder {
  const recordPayload = options.recordPayload ?? false;

  return {
    async invoked(args) {
      await lineage.actionInvoked(
        {
          action: args.action,
          payloadHash: args.payloadHash,
          tier: args.tier,
          ...(args.correlationId != null ? { correlationId: args.correlationId } : {}),
        },
        { kind: "user", id: args.principal.id },
        args.tenant,
      );
    },
    async denied(args) {
      await lineage.actionDenied(
        {
          action: args.action,
          payloadHash: args.payloadHash,
          tier: args.tier,
          reason: args.reason,
          ...(args.correlationId != null ? { correlationId: args.correlationId } : {}),
        },
        { kind: "user", id: args.principal.id },
        args.tenant,
      );
    },
    async approvalRequested(args) {
      await lineage.actionApprovalRequested(
        {
          action: args.action,
          payloadHash: args.payloadHash,
          tier: args.tier,
          requestId: args.requestId,
          ...(recordPayload ? { payload: args.payload } : {}),
          ...(args.correlationId != null ? { correlationId: args.correlationId } : {}),
        },
        { kind: "user", id: args.principal.id },
        args.tenant,
      );
    },
    async approved(args) {
      await lineage.actionApproved(
        {
          action: args.action,
          payloadHash: args.payloadHash,
          approverId: args.grant.approverId,
          requesterId: args.grant.requesterId,
          ...(args.correlationId != null ? { correlationId: args.correlationId } : {}),
        },
        { kind: "user", id: args.principal.id },
        args.tenant,
      );
    },
  };
}

import { computeSpecHash, type JsonObject, type Surface, type UISpec } from "@kohaku-ui/spec-core";
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
      });
    },
  };
}

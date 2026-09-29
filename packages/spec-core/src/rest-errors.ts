import type { ActionParamIssue } from "./action-params.js";

/**
 * The wire contract for the error envelope of the REST profile (SPEC §6.1).
 *
 * Why it lives here: error codes are part of the "protocol", not of the "server implementation
 * (host-rest)", and are shared by both the host (host-rest) and the client (client). To respect the
 * dependency direction (no back-flow), the wire-contract types live in the most-upstream spec-core, and
 * host-rest swaps its import site to a backward-compatible re-export.
 *
 * These are plain TypeScript types (not Zod schemas), so they do not affect `spec/schemas` generation
 * (generate-schemas).
 */
export type HostErrorCode =
  | "BAD_REQUEST"
  | "INTENT_INVALID"
  | "CAPABILITY_REQUIRED"
  | "CAPABILITY_DENIED"
  | "REF_NOT_FOUND"
  | "SOURCE_MISMATCH"
  | "COMPOSE_FAILED"
  | "INTERNAL"
  | "NOT_IMPLEMENTED"
  // For the named routes of the governance side (promotions)
  | "NOT_FOUND"
  | "PROMOTION_INVALID"
  | "PROMOTION_NOT_PUBLISHED"
  // Rate limiting (SPEC §6.1, REST-RL-001): a host MAY enforce a rate limit; when it does, an
  // over-limit request MUST use this code with HTTP 429.
  | "RATE_LIMITED"
  // Governed actions (SPEC §6.1, ACT-PRM-001): the invoke payload failed `validateActionParams`
  // against the action's `paramsSchema`. MUST be reported with HTTP 422, before `DomainPort.invoke`
  // ever runs.
  | "ACTION_PARAMS_INVALID"
  // Governed actions (SPEC §6.1, ACT-APR-001): the action's tier requires a same-request `confirmed:
  // true` (tier "confirm") or a valid unused approval token bound to this exact invocation (tier
  // "approve"), and neither was satisfied. MUST be reported with HTTP 403.
  | "APPROVAL_REQUIRED";

/**
 * Discriminators of the governance-plane errors thrown by the promotion / fixation services
 * (@kohaku-ui/lineage). host-rest maps these errors to HTTP statuses by structural matching on `code` / `name`
 * (it must not import lineage — dependency direction), so the literals are a wire-adjacent contract. Sharing
 * them via spec-core lets the thrower (lineage) pin its discriminators and the host (host-rest) match with the
 * same constants, so a rename on either side is caught by the compiler instead of silently falling through to
 * 500 INTERNAL (or, before `artifactNotFoundCode` existed, a message-text regex that a wording change could
 * silently break).
 */
export const GOVERNANCE_ERROR_DISCRIMINATORS = {
  /** PromotionNotPublishedError.code (approve's batch transition did not reach published -> 409) */
  notPublishedCode: "PROMOTION_NOT_PUBLISHED",
  /** PromotionNotRejectedError.code (reject's batch transition did not reach rejected -> 422 PROMOTION_INVALID) */
  notRejectedCode: "PROMOTION_NOT_REJECTED",
  /** PromotionNotRejectedError.name (kept alongside notRejectedCode; host-rest still matches by name here) */
  notRejectedName: "PromotionNotRejectedError",
  /** TransitionError.name (a single transition was rejected -> 422 PROMOTION_INVALID) */
  transitionName: "TransitionError",
  /** FixationUnsupportedError.code (StoragePort.deleteFixation is unimplemented -> 501 NOT_IMPLEMENTED) */
  fixationUnsupportedCode: "FIXATION_UNSUPPORTED",
  /** The Error thrown by candidate-store's require() when the artifact does not exist (or belongs to another
   * tenant) -> 404 NOT_FOUND. Discriminated by code rather than a message-text match. */
  artifactNotFoundCode: "PROMOTION_ARTIFACT_NOT_FOUND",
} as const;

/** @deprecated Use {@link GOVERNANCE_ERROR_DISCRIMINATORS}; kept as an alias for backward compatibility. */
export const PROMOTION_ERROR_DISCRIMINATORS = GOVERNANCE_ERROR_DISCRIMINATORS;

/**
 * The pending-approval descriptor on a 403 APPROVAL_REQUIRED envelope (SPEC §6.1, ACT-APR-001), for a
 * `"confirm"` or `"approve"` tier action that was invoked without satisfying its gate. `requestId` is a
 * fresh, opaque identifier for this specific approval request (distinct from `ErrorEnvelope.error.requestId`,
 * which correlates the *error response itself* to server logs). It is a correlation handle for an
 * approver-facing flow (the same id is stamped on the `action.approvalRequested` lineage event, queryable via
 * `GET /lineage?type=action.approvalRequested`); no request body field accepts it back, and the gate does not
 * persist any request state keyed by it -- the retry that carries the approval token is a fresh invoke
 * (`POST /binding/action` with `approval`) that is re-checked from scratch against the payload and the
 * token's binding. `payloadHash` is the `actionPayloadHash` of the payload the approval must be bound to.
 */
export interface ApprovalRequiredInfo {
  requestId: string;
  action: string;
  tier: "confirm" | "approve";
  payloadHash: string;
}

export interface ErrorEnvelope {
  error: {
    code: HostErrorCode;
    message: string;
    /**
     * Correlation ID. Issued and attached only when the failure-path observability hook (host-side
     * onError) is wired, and equal to the requestId passed to onError (so logs and client errors can be
     * correlated). If the hook is not wired, it is not attached = the response is unchanged.
     */
    requestId?: string;
    /**
     * The promotion state that stopped the transition. Present only on the 409 PROMOTION_NOT_PUBLISHED
     * envelope (approve's batch transition reached this state instead of "published"). This is distinct
     * from the HTTP status code of the response.
     */
    status?: string;
    /**
     * The client-suggested backoff before retrying, in milliseconds. Present only on the 429
     * RATE_LIMITED envelope (SPEC §6.1, REST-RL-001). Carries the same backoff a host SHOULD also
     * expose via the HTTP `Retry-After` header, in a form usable by a non-HTTP transport (the MCP
     * profile's structured tool error, §6.2) and by callers without access to response headers.
     */
    retryAfterMs?: number;
    /**
     * Per-field validation problems. Present only on the 422 ACTION_PARAMS_INVALID envelope (SPEC
     * §6.1, ACT-PRM-001) — the exact array `validateActionParams` (spec-core's `action-params.ts`)
     * returned for the rejected payload.
     */
    issues?: ActionParamIssue[];
    /** The pending-approval descriptor. Present only on the 403 APPROVAL_REQUIRED envelope (SPEC §6.1, ACT-APR-001). */
    approval?: ApprovalRequiredInfo;
  };
}

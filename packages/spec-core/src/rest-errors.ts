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
  | "PROMOTION_NOT_PUBLISHED";

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
  };
}

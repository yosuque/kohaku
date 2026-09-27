import type { ActionParamIssue, ErrorEnvelope, HostErrorCode } from "@kohaku-ui/spec-core";

/**
 * A discriminable exception representing the error envelope `{error:{code,message}}` returned by the host (REST profile §6.1).
 *
 * With hand-written fetch, `throw new Error(\`${code}: ${message}\`)` collapses the code into a string, making it
 * impossible to branch by code type-safely. This exception holds `code` (typed HostErrorCode), so on the `catch`
 * side you can write exhaustive branches like `err.code === "CAPABILITY_DENIED"` with type checking. `status` is the
 * HTTP status, and `requestId` is a correlation ID issued by the host's observability hook (for log matching; undefined when unwired).
 */
export class KohakuHostError extends Error {
  readonly code: HostErrorCode;
  readonly status: number;
  readonly requestId?: string;
  /**
   * The promotion state that stopped the transition (envelope's error.status). Only present on the 409
   * PROMOTION_NOT_PUBLISHED error. Named distinctly from `status` (the HTTP status of this response) to
   * avoid confusion between the two.
   */
  readonly promotionStatus?: string;
  /**
   * The client-suggested backoff before retrying, in milliseconds (envelope's error.retryAfterMs).
   * Only present on a 429 RATE_LIMITED error (SPEC §6.1, REST-RL-001).
   */
  readonly retryAfterMs?: number;
  /**
   * Per-field validation problems (envelope's error.issues). Only present on a 422
   * ACTION_PARAMS_INVALID error (SPEC §6.1, ACT-PRM-001) — the exact array `validateActionParams`
   * returned for the rejected payload.
   */
  readonly issues?: ActionParamIssue[];
  /**
   * The pending-approval descriptor (envelope's error.approval). Only present on a 403
   * APPROVAL_REQUIRED error (SPEC §6.1, ACT-APR-001) for a "confirm" or "approve" tier action that was
   * invoked without satisfying its gate. See {@link ErrorEnvelope}'s doc comment for the field's role.
   */
  readonly approval?: { requestId: string; action: string; tier: "confirm" | "approve"; payloadHash: string };

  constructor(
    code: HostErrorCode,
    message: string,
    status: number,
    requestId?: string,
    promotionStatus?: string,
    retryAfterMs?: number,
    issues?: ActionParamIssue[],
    approval?: { requestId: string; action: string; tier: "confirm" | "approve"; payloadHash: string },
  ) {
    super(message);
    this.name = "KohakuHostError";
    this.code = code;
    this.status = status;
    if (requestId != null) this.requestId = requestId;
    if (promotionStatus != null) this.promotionStatus = promotionStatus;
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs;
    if (issues != null) this.issues = issues;
    if (approval != null) this.approval = approval;
  }
}

/** Type guard narrowing `unknown` to KohakuHostError (for branching in catch clauses). */
export function isKohakuHostError(e: unknown): e is KohakuHostError {
  return e instanceof KohakuHostError;
}

/**
 * Builds a KohakuHostError from the HTTP status and response body. If the body is `{error:{code,message}}` shaped,
 * it adopts that code, message, and requestId; otherwise it falls back to INTERNAL + `HTTP <status>`
 * (so the exception always has a code even when the host returns a non-conformant response).
 */
export function hostErrorFromResponse(status: number, body: unknown): KohakuHostError {
  const envelope = (body as Partial<ErrorEnvelope> | null | undefined)?.error;
  if (envelope != null && typeof envelope.code === "string") {
    return new KohakuHostError(
      envelope.code,
      envelope.message ?? `HTTP ${status}`,
      status,
      envelope.requestId,
      envelope.status,
      envelope.retryAfterMs,
      envelope.issues,
      envelope.approval,
    );
  }
  return new KohakuHostError("INTERNAL", `HTTP ${status}`, status);
}

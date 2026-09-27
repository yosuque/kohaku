import type { ActionParamIssue } from "@kohaku-ui/spec-core";

export type BindingErrorCode =
  | "BAD_REF"
  | "UNAUTHORIZED"
  | "REF_NOT_FOUND"
  | "STALE_VERSION"
  | "RESOLVE_FAILED"
  // Governed actions (design.md #62, SPEC ACT-PRM-001): the invoke payload failed validation against
  // the action's paramsSchema (host's 422 ACTION_PARAMS_INVALID). Distinguished from RESOLVE_FAILED so
  // a caller (renderer-core's runInvokeTarget) can drive an "invalid" phase without string-matching.
  | "ACTION_PARAMS_INVALID"
  // Governed actions (design.md #62/#63, SPEC ACT-APR-001): the action's tier requires a same-request
  // confirmed: true (tier "confirm") or a valid unused approval token (tier "approve"), and neither was
  // satisfied (host's 403 APPROVAL_REQUIRED). Distinguished from UNAUTHORIZED (a genuine capability
  // denial) so a caller can drive an "awaitingApproval" phase instead of a hard failure.
  | "APPROVAL_REQUIRED";

export class BindingError extends Error {
  readonly code: BindingErrorCode;
  readonly status?: number;
  /**
   * Per-field validation problems. Only present on an ACTION_PARAMS_INVALID error — the exact array the
   * host's `validateActionParams` returned for the rejected payload (SPEC §6.1, ACT-PRM-001).
   */
  readonly issues?: ActionParamIssue[];
  /**
   * The pending-approval descriptor. Only present on an APPROVAL_REQUIRED error (SPEC §6.1,
   * ACT-APR-001) — mirrors `@kohaku-ui/client`'s `KohakuHostError.approval`.
   */
  readonly approval?: { requestId: string; action: string; tier: "confirm" | "approve"; payloadHash: string };

  constructor(
    code: BindingErrorCode,
    message: string,
    opts: {
      status?: number;
      cause?: unknown;
      issues?: ActionParamIssue[];
      approval?: { requestId: string; action: string; tier: "confirm" | "approve"; payloadHash: string };
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "BindingError";
    this.code = code;
    this.status = opts.status;
    if (opts.issues != null) this.issues = opts.issues;
    if (opts.approval != null) this.approval = opts.approval;
  }
}

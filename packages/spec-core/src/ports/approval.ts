/**
 * Default lifetime (seconds) of an approval token when the issuer is given no explicit TTL
 * (design.md #63). Deliberately much shorter than `DEFAULT_CAPABILITY_TTL_SECONDS`: an approval token
 * authorizes one specific human decision about one specific payload, not a session's worth of reads.
 */
export const DEFAULT_APPROVAL_TTL_SECONDS = 300;

/**
 * The claims a stateless bound approval token carries (design.md #63). An `ApprovalPort.verifyApproval`
 * that accepts a token MUST have checked every one of these against the request it was presented for
 * (action name, payload hash, requester identity, tenant, expiry) before returning `{ ok: true }` —
 * this type is what a caller receives back on success, not what it is expected to inspect itself.
 */
export interface ApprovalGrant {
  action: string;
  payloadHash: string;
  /** The principal id of whoever approved. MUST differ from `requesterId` (design.md #63). */
  approverId: string;
  /** The principal id of whoever will invoke (or already attempted to invoke) the action. */
  requesterId: string;
  tenant?: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Unique id for this grant, consumed by an `ApprovalStore` when single-use enforcement is configured. */
  jti: string;
}

/**
 * The `code` an `ApprovalIssueError` carries. A host (and a custom `ApprovalPort`, which need not import
 * the class) discriminates the client-caused failure structurally by this string, the same convention the
 * governance errors follow.
 */
export const APPROVAL_ISSUE_ERROR_CODE = "APPROVAL_ISSUE_REJECTED";

/**
 * Thrown by `ApprovalPort.issueApproval` when it refuses a request for a reason the caller caused and can
 * fix (e.g. self-approval). Its message is safe to show a client as-is; `POST /approvals` maps exactly this
 * to 400. Any other error thrown by `issueApproval` is an infrastructure failure, reported to the
 * observability hook and surfaced to the client as a fixed-text 500.
 */
export class ApprovalIssueError extends Error {
  readonly code = APPROVAL_ISSUE_ERROR_CODE;
  constructor(message: string) {
    super(message);
    this.name = "ApprovalIssueError";
  }
}

export interface ApprovalVerifyResult {
  ok: boolean;
  grant?: ApprovalGrant;
  reason?: string;
}

/**
 * Issuance and verification of stateless, short-lived approval tokens for `"approve"`-tier actions
 * (design.md #63). Structurally parallel to `AuthzPort` (issue / verify, fail-open denial vs.
 * fail-closed infrastructure failure), but a distinct port: an approval authorizes one human decision
 * about one exact payload, not a read/write scope over a Spec's lifetime, and a concrete token format
 * MUST NOT be interchangeable with a capability token (see `authz-hmac`, which derives the approval
 * MAC key under its own label and covers the `"kohaku-approval.v2."` prefix in the MAC input, so the two
 * token domains cannot be replayed against each other even when they share one secret).
 */
export interface ApprovalPort {
  /**
   * Issues a token bound to `(action, payloadHash, requesterId, tenant)`. `approverId` MUST differ from
   * `requesterId` — an implementation MUST reject issuing a self-approval (design.md #63) rather than
   * leave that check to the caller. Default TTL `DEFAULT_APPROVAL_TTL_SECONDS`.
   *
   * Error contract: a rejection the caller caused (self-approval, an unacceptable request) MUST be
   * thrown as an `ApprovalIssueError` (or an `Error` whose `code` is `APPROVAL_ISSUE_ERROR_CODE`); the
   * host reports its message to the client as a 400. Any other thrown error is treated as an
   * infrastructure failure: it reaches the observability hook and the client only sees a fixed 500
   * message, so an implementation MUST NOT rely on its own message text reaching the client.
   * An implementation SHOULD bound the lifetime it grants (`opts.ttlSeconds` is caller-supplied), since a
   * stateless token without an `ApprovalStore` is replayable until it expires.
   */
  issueApproval(
    input: { action: string; payloadHash: string; requesterId: string; approverId: string; tenant?: string },
    opts?: { ttlSeconds?: number },
  ): Promise<string>;
  /**
   * Verifies `token` against the exact `(action, payloadHash, requesterId, tenant)` it is being
   * presented for. A denial (expired, malformed, wrong binding, already consumed) is a normal, expected
   * outcome and MUST be reported as `{ ok: false, reason }`, never thrown. `verifyApproval` MUST throw
   * only on an infrastructure failure it cannot itself classify as allow/deny (e.g. an `ApprovalStore`
   * outage) — such a thrown `verifyApproval` is fail-closed: the caller MUST treat it as a denial.
   */
  verifyApproval(
    token: string,
    req: { action: string; payloadHash: string; requesterId: string; tenant?: string },
  ): Promise<ApprovalVerifyResult>;
}

/**
 * Optional persistence for single-use enforcement of approval tokens, mirroring
 * `CapabilityRevocationStore`'s role for capability tokens. When an `ApprovalPort` is configured with
 * one, `verifyApproval` MUST call `consume` exactly once per verification attempt and deny (`{ ok:
 * false }`) when it returns `false` (already consumed). A `consume` that throws (store failure) is an
 * infrastructure failure `verifyApproval` cannot classify: it propagates the throw, and the host treats a
 * thrown `verifyApproval` as a denial (fail-closed, per `ApprovalPort.verifyApproval`'s own contract). An
 * `ApprovalPort` given no store keeps a token usable
 * repeatedly until it expires (the caller's choice, e.g. for a demo/dev environment).
 */
export interface ApprovalStore {
  /**
   * Atomically marks `jti` as consumed until `expiresAt` (epoch seconds) if it was not already; returns
   * `true` on first consumption, `false` if `jti` was already consumed (a replay attempt). The store MAY
   * drop the entry after `expiresAt`.
   */
  consume(jti: string, expiresAt: number): Promise<boolean>;
  close?(): Promise<void>;
}

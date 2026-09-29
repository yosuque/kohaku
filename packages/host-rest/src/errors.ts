import type {
  ActionParamIssue,
  ApprovalRequiredInfo,
  ErrorEnvelope,
  HostErrorCode,
} from "@kohaku-ui/spec-core";

/**
 * The REST plane's error envelope (the list of codes canonicalized in spec §6.1).
 *
 * The type bodies (HostErrorCode / ErrorEnvelope) are a wire contract, so they were moved to spec-core (to share
 * with client; avoiding a reverse dependency). This is a backward-compatible re-export, so existing import sites
 * (`@kohaku-ui/host-rest`'s errors) do not need to be changed. errorBody is a server-side construction helper, so it stays in host-rest.
 */
export type { ErrorEnvelope, HostErrorCode } from "@kohaku-ui/spec-core";

export function errorBody(
  code: HostErrorCode,
  message: string,
  requestId?: string,
  retryAfterMs?: number,
  /** Present only on ACTION_PARAMS_INVALID (SPEC §6.1, ACT-PRM-001) -- validateActionParams's issues. */
  issues?: ActionParamIssue[],
  /** Present only on APPROVAL_REQUIRED (SPEC §6.1, ACT-APR-001). */
  approval?: ApprovalRequiredInfo,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(requestId != null ? { requestId } : {}),
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
      ...(issues != null ? { issues } : {}),
      ...(approval != null ? { approval } : {}),
    },
  };
}

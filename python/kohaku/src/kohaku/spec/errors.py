"""Coded structured errors and the wire contract for the REST error envelope (port of TS errors.ts / rest-errors.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from .action_params import ActionParamIssue

if TYPE_CHECKING:
    from .validate import SpecIssue

type SpecErrorCode = Literal[
    "PARSE_FAILED",
    "STRUCTURE_INVALID",
    "PATCH_PARSE_FAILED",
    "PATCH_BASE_MISMATCH",
    "PATCH_APPLY_FAILED",
]


class SpecError(Exception):
    """Coded structured error. Conformance tests assert against the code."""

    def __init__(
        self, code: SpecErrorCode, message: str, issues: list[SpecIssue] | None = None
    ) -> None:
        super().__init__(message)
        self.code: SpecErrorCode = code
        self.issues: list[SpecIssue] = issues if issues is not None else []


@dataclass(frozen=True)
class IntentValidationIssue:
    """One reason a directly-specified Intent (`kind: "intent"`) failed `SupportsValidateIntent.validate_intent`
    (kohaku.spec.ports; port of TS spec-core's IntentValidationIssue)."""

    path: str
    """Dot-separated path into `params` (empty string for a whole-Intent problem, e.g. an unknown canonical)."""
    message: str
    """Client-safe explanation. May name the Intent / param, but must never include a stack trace or raw
    internal values."""


class IntentValidationError(Exception):
    """Raised by `SupportsValidateIntent.validate_intent` (kohaku.spec.ports) when a directly-specified Intent
    fails validation: an unknown canonical, an unknown param key, or a param value that fails the Intent's own
    schema. `code` reuses the existing `HostErrorCode` "INTENT_INVALID" (SPEC §6.1) rather than minting a new
    one, so host_rest / host_mcp map it the same way they already map other 422s (and, by carrying a string
    `code` attribute, it is automatically a "typed" host error per host_core's `is_typed_host_error` -- its own
    `message` passes through to the client instead of a fixed fallback string). `message` and every issue's
    `message` must be safe to show a client as-is. Port of TS spec-core's IntentValidationError (errors.ts).
    """

    def __init__(self, message: str, issues: list[IntentValidationIssue] | None = None) -> None:
        super().__init__(message)
        self.code: Literal["INTENT_INVALID"] = "INTENT_INVALID"
        self.issues: list[IntentValidationIssue] = issues if issues is not None else []


# Wire contract of the REST profile's (SPEC §6.1) error envelope.
# Error codes are part of the "protocol", not the "server implementation", and are shared by host and client.
type HostErrorCode = Literal[
    "BAD_REQUEST",
    "INTENT_INVALID",
    "CAPABILITY_REQUIRED",
    "CAPABILITY_DENIED",
    "REF_NOT_FOUND",
    "SOURCE_MISMATCH",
    "COMPOSE_FAILED",
    "INTERNAL",
    "NOT_IMPLEMENTED",
    # For the named routes of the governance (promotions) surface
    "NOT_FOUND",
    "PROMOTION_INVALID",
    "PROMOTION_NOT_PUBLISHED",
    # Rate limiting (SPEC §6.1, REST-RL-001): a host MAY enforce a rate limit; when it does, an
    # over-limit request MUST use this code with HTTP 429.
    "RATE_LIMITED",
    # Governed actions (SPEC §6.1, ACT-PRM-001): the invoke payload failed validate_action_params
    # against the action's paramsSchema. MUST be reported with HTTP 422, before DomainPort.invoke ever
    # runs.
    "ACTION_PARAMS_INVALID",
    # Governed actions (SPEC §6.1, ACT-APR-001): the action's tier requires a same-request
    # `confirmed: true` (tier "confirm") or a valid unused approval token bound to this exact
    # invocation (tier "approve"), and neither was satisfied. MUST be reported with HTTP 403.
    "APPROVAL_REQUIRED",
]


@dataclass(frozen=True)
class ApprovalRequiredInfo:
    """Wire shape of `ErrorEnvelope.approval` (SPEC §6.1, ACT-APR-001). Port of TS rest-errors.ts's inline
    `error.approval` field."""

    requestId: str
    action: str
    tier: Literal["confirm", "approve"]
    payloadHash: str


@dataclass(frozen=True)
class ErrorEnvelope:
    """Wire form of `{error: {code, message, requestId?}}`."""

    code: HostErrorCode
    message: str
    requestId: str | None = None
    """Correlation ID. Issued and attached only when the failure-path observation hook (onError) is wired up."""
    status: str | None = None
    """The promotion state that stopped the transition. Present only on the 409 PROMOTION_NOT_PUBLISHED
    envelope (approve's batch transition reached this state instead of "published"). Distinct from the HTTP
    status code of the response."""
    retryAfterMs: int | None = None
    """The client-suggested backoff before retrying, in milliseconds. Present only on the 429
    RATE_LIMITED envelope (SPEC §6.1, REST-RL-001); mirrors the HTTP Retry-After header a host SHOULD
    also set, in a form usable by a non-HTTP transport (host_mcp's structured tool error, §6.2)."""
    issues: list[ActionParamIssue] | None = None
    """Per-field validation problems. Present only on the 422 ACTION_PARAMS_INVALID envelope (SPEC §6.1,
    ACT-PRM-001) -- the exact list `validate_action_params` (`kohaku.spec.action_params`) returned."""
    approval: ApprovalRequiredInfo | None = None
    """The pending-approval descriptor. Present only on the 403 APPROVAL_REQUIRED envelope (SPEC §6.1,
    ACT-APR-001)."""

    def to_wire(self) -> dict[str, object]:
        error: dict[str, object] = {"code": self.code, "message": self.message}
        if self.requestId is not None:
            error["requestId"] = self.requestId
        if self.status is not None:
            error["status"] = self.status
        if self.retryAfterMs is not None:
            error["retryAfterMs"] = self.retryAfterMs
        if self.issues is not None:
            error["issues"] = [
                {"path": issue.path, "code": issue.code, "message": issue.message} for issue in self.issues
            ]
        if self.approval is not None:
            error["approval"] = {
                "requestId": self.approval.requestId,
                "action": self.approval.action,
                "tier": self.approval.tier,
                "payloadHash": self.approval.payloadHash,
            }
        return {"error": error}


class GovernanceErrorDiscriminators:
    """Discriminators of the governance-plane errors thrown by the promotion / fixation services
    (kohaku.lineage). host_rest maps these errors to HTTP statuses by structural matching on `code` / `name`
    (it must not import lineage — dependency direction), so the literals are a wire-adjacent contract. Sharing
    them via kohaku.spec lets the thrower (lineage) pin its discriminators and the host (host_rest) match with
    the same constants, mirroring TS spec-core's GOVERNANCE_ERROR_DISCRIMINATORS (rest-errors.ts) so a rename on
    either side of either language is a single, grep-able place to fix.
    """

    NOT_PUBLISHED_CODE = "PROMOTION_NOT_PUBLISHED"
    """PromotionNotPublishedError.code (approve's batch transition did not reach published -> 409)."""
    NOT_REJECTED_CODE = "PROMOTION_NOT_REJECTED"
    """PromotionNotRejectedError.code (reject's batch transition did not reach rejected -> 422 PROMOTION_INVALID)."""
    NOT_REJECTED_NAME = "PromotionNotRejectedError"
    TRANSITION_NAME = "TransitionError"
    """TransitionError.name (a single transition was rejected -> 422 PROMOTION_INVALID)."""
    FIXATION_UNSUPPORTED_CODE = "FIXATION_UNSUPPORTED"
    """FixationUnsupportedError.code (StoragePort.delete_fixation is unimplemented -> 501 NOT_IMPLEMENTED)."""
    ARTIFACT_NOT_FOUND_CODE = "PROMOTION_ARTIFACT_NOT_FOUND"
    """The exception raised by the promotion service when the artifact does not exist (or belongs to another
    tenant) -> 404 NOT_FOUND. Discriminated by code rather than a message-text match."""

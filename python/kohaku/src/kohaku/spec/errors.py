"""Coded structured errors and the wire contract for the REST error envelope (port of TS errors.ts / rest-errors.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

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
]


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

    def to_wire(self) -> dict[str, object]:
        error: dict[str, object] = {"code": self.code, "message": self.message}
        if self.requestId is not None:
            error["requestId"] = self.requestId
        if self.status is not None:
            error["status"] = self.status
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

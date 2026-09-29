"""Coded error for binding resolution (port of TS data-binding/errors.ts)."""

from __future__ import annotations

from typing import Literal

from kohaku.spec import ActionParamIssue, ApprovalRequiredInfo

type BindingErrorCode = Literal[
    "BAD_REF",
    "UNAUTHORIZED",
    "REF_NOT_FOUND",
    "STALE_VERSION",
    "RESOLVE_FAILED",
    # Governed actions (design.md #62, SPEC ACT-PRM-001): the invoke payload failed validation against
    # the action's paramsSchema (host's 422 ACTION_PARAMS_INVALID). Distinguished from RESOLVE_FAILED so
    # a caller can drive an "invalid" phase without string-matching.
    "ACTION_PARAMS_INVALID",
    # Governed actions (design.md #62/#63, SPEC ACT-APR-001): the action's tier requires a same-request
    # confirmed=True (tier "confirm") or a valid unused approval token (tier "approve"), and neither was
    # satisfied (host's 403 APPROVAL_REQUIRED). Distinguished from UNAUTHORIZED (a genuine capability
    # denial) so a caller can drive an "awaiting_approval" phase instead of a hard failure.
    "APPROVAL_REQUIRED",
    # The host rate limited the request (HTTP 429, SPEC REST-RL-001). Distinguished from RESOLVE_FAILED so
    # a caller can back off for `retry_after_ms` instead of treating it as a hard failure.
    "RATE_LIMITED",
]


class BindingError(Exception):
    def __init__(
        self,
        code: BindingErrorCode,
        message: str,
        *,
        status: int | None = None,
        issues: list[ActionParamIssue] | None = None,
        approval: ApprovalRequiredInfo | None = None,
        retry_after_ms: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code: BindingErrorCode = code
        self.status = status
        self.issues = issues
        """Per-field validation problems. Only present on an ACTION_PARAMS_INVALID error — the exact
        array the host's validate_action_params returned for the rejected payload (SPEC §6.1, ACT-PRM-001)."""
        self.approval = approval
        """The pending-approval descriptor (kohaku.spec's ApprovalRequiredInfo). Only present on an
        APPROVAL_REQUIRED error (SPEC §6.1, ACT-APR-001)."""
        self.retry_after_ms = retry_after_ms
        """The host's suggested backoff in milliseconds. Only present on a RATE_LIMITED error whose 429
        response carried `error.retryAfterMs` (SPEC §6.1, REST-RL-001)."""

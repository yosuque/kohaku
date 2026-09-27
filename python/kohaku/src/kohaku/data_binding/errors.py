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

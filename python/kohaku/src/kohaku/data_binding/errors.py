"""Coded error for binding resolution (port of TS data-binding/errors.ts)."""

from __future__ import annotations

from typing import Literal

type BindingErrorCode = Literal[
    "BAD_REF",
    "UNAUTHORIZED",
    "REF_NOT_FOUND",
    "STALE_VERSION",
    "RESOLVE_FAILED",
]


class BindingError(Exception):
    def __init__(
        self, code: BindingErrorCode, message: str, *, status: int | None = None
    ) -> None:
        super().__init__(message)
        self.code: BindingErrorCode = code
        self.status = status

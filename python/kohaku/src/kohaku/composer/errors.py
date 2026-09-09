"""Coded compose errors (port of TS errors.ts)."""

from __future__ import annotations

from typing import Literal

type ComposeErrorCode = Literal["SEMANTIC_FAILED", "LLM_INVALID", "L2_DISABLED", "INTERNAL"]


class ComposeError(Exception):
    def __init__(
        self, code: ComposeErrorCode, message: str, *, cause: BaseException | None = None
    ) -> None:
        super().__init__(message)
        self.code: ComposeErrorCode = code
        if cause is not None:
            self.__cause__ = cause

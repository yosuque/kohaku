"""The ``Authorization: Bearer`` header parser (port of packages/authz-jwt/src/bearer.ts)."""

from __future__ import annotations

import re

_BEARER = re.compile(r"\s*bearer\s+(\S+)\s*", re.IGNORECASE)


def bearer_token(header: str | None) -> str | None:
    """The token of an ``Authorization: Bearer <token>`` header (scheme matched case-insensitively), or None."""
    if header is None:
        return None
    match = _BEARER.fullmatch(header)
    return match.group(1) if match is not None else None

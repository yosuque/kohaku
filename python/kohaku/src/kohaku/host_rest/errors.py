"""REST-side error envelope construction helper (port of packages/host-rest/src/errors.ts).

The wire-contract types themselves (HostErrorCode / ErrorEnvelope) are owned by spec-core (kohaku.spec).
This module holds only the server-side construction helper (the same division of roles as TS).
"""

from __future__ import annotations

from kohaku.spec import HostErrorCode


def error_body(
    code: HostErrorCode, message: str, request_id: str | None = None
) -> dict[str, object]:
    """Return the wire dict `{error: {code, message, requestId?}}`.

    Every route resolves a request_id for every request now (ops; see _routes.shared.request_id_of) and
    passes it here on every error response, regardless of whether on_error is wired. request_id stays optional
    on this function only so a caller building an error body outside the request lifecycle can omit it.
    """
    error: dict[str, object] = {"code": code, "message": message}
    if request_id is not None:
        error["requestId"] = request_id
    return {"error": error}

"""The JWT `RequestIdentity` scheme (port of apps/sample-api/src/app/request-identity-jwt.ts).

Split out of `request_identity` so ``kohaku.authz_jwt`` (and PyJWT behind it) is imported only when
``KOHAKU_AUTHZ=jwt`` actually selects this scheme.

The middleware verifies the bearer token once per request and stores the identity on ``request.state``; the
``auth`` / ``tenant`` hooks read it back. A missing or invalid token is a 401 with the standard error envelope
(CAPABILITY_DENIED -- the SPEC §6.1 code set has no separate "unauthenticated" code, and the envelope is what
clients already parse). Principal / roles / tenant then all come from the token, never from headers.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from kohaku.authz_jwt import JwtIdentityError, JwtIdentityResolver, ResolvedIdentity
from kohaku.host_rest import error_body
from kohaku.spec import Principal

from .request_identity import RequestIdentity

if TYPE_CHECKING:
    from mcp.server import ServerRequestContext

    from .request_identity import CallNext

_IDENTITY_STATE = "kohaku_identity"
_logger = logging.getLogger(__name__)


def _log_rejected(error: Exception) -> str:
    """Returns the code to show the caller, and logs why the token was rejected. The response stays opaque (only
    the code); the operator gets the real reason (e.g. the PyJWT error behind INVALID_TOKEN: expired, wrong
    audience, unknown kid...). A missing header is routine and not logged. The token itself is never logged, and
    PyJWT error messages do not carry it."""
    reason = error.code if isinstance(error, JwtIdentityError) else "INVALID_TOKEN"
    if reason != "MISSING_TOKEN":
        _logger.warning(
            "[identity] bearer token rejected (%s): %s", reason, error.__cause__ or error
        )
    return reason


def create_jwt_mcp_resolve_principal(
    identity: JwtIdentityResolver,
) -> Callable[[ServerRequestContext[Any]], Awaitable[Principal]]:
    """The MCP profile's per-tool-call principal resolution under ``KOHAKU_AUTHZ=jwt`` (TS: sample-mcp's
    ``resolvePrincipal`` default): the caller's principal comes from that call's own HTTP ``Authorization`` bearer
    token. ``McpHostDeps.resolve_principal`` is fail-closed -- a raise becomes a structured tool error, never an
    anonymous call -- so a missing or invalid token fails the call (``JwtIdentityError``). The stdio entry has no
    HTTP request at all (``ctx.request`` is None), so under jwt every stdio tool call fails with MISSING_TOKEN:
    stdio has no transport-level place to carry a bearer token, so ``jwt`` is effectively an HTTP-only choice there.
    The tenant the token carries is discarded: the MCP profile never resolves a tenant (it is keyed by
    ``intentHash`` alone), yet the token's tenant claim is still required/validated by the identity resolver."""

    async def resolve_principal(ctx: ServerRequestContext[Any]) -> Principal:
        request = ctx.request
        header = request.headers.get("authorization") if request is not None else None
        try:
            return (await identity.from_authorization_header(header)).principal
        except Exception as e:
            _log_rejected(e)
            raise

    return resolve_principal


def create_jwt_request_identity(identity: JwtIdentityResolver) -> RequestIdentity:
    def read(request: Request) -> ResolvedIdentity | None:
        resolved = getattr(request.state, _IDENTITY_STATE, None)
        return resolved if isinstance(resolved, ResolvedIdentity) else None

    async def middleware(request: Request, call_next: CallNext) -> Response:
        try:
            resolved = await identity.from_authorization_header(
                request.headers.get("authorization")
            )
        except Exception as e:
            reason = _log_rejected(e)
            return JSONResponse(
                error_body("CAPABILITY_DENIED", f"authentication required ({reason})"),
                status_code=401,
            )
        setattr(request.state, _IDENTITY_STATE, resolved)
        return await call_next(request)

    def auth(request: Request) -> Principal | None:
        resolved = read(request)
        return resolved.principal if resolved is not None else None

    def tenant(request: Request) -> str | None:
        resolved = read(request)
        return resolved.tenant if resolved is not None else None

    return RequestIdentity(auth=auth, tenant=tenant, middleware=middleware)

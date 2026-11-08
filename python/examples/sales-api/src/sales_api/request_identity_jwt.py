"""The JWT `RequestIdentity` scheme (port of apps/sample-api/src/app/request-identity-jwt.ts).

Split out of `request_identity` so ``kohaku.authz_jwt`` (and PyJWT behind it) is imported only when
``KOHAKU_AUTHZ=jwt`` actually selects this scheme.

The middleware verifies the bearer token once per request and stores the identity on ``request.state``; the
``auth`` / ``tenant`` hooks read it back. A missing or invalid token is a 401 with the standard error envelope
(CAPABILITY_DENIED -- the SPEC §6.1 code set has no separate "unauthenticated" code, and the envelope is what
clients already parse). Principal / roles / tenant then all come from the token, never from headers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from kohaku.authz_jwt import JwtIdentityError, JwtIdentityResolver, ResolvedIdentity
from kohaku.host_rest import error_body
from kohaku.spec import Principal

from .request_identity import RequestIdentity

if TYPE_CHECKING:
    from .request_identity import CallNext

_IDENTITY_STATE = "kohaku_identity"


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
            reason = e.code if isinstance(e, JwtIdentityError) else "INVALID_TOKEN"
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

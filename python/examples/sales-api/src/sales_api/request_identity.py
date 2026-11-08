"""REST-only request -> principal/tenant resolution (port of apps/sample-api/src/app/request-identity.ts).

`RequestIdentity` bundles what the sample's host wiring needs from an identity scheme: host_rest's ``auth`` and
``tenant`` hooks plus, optionally, an HTTP middleware that authenticates a request before it reaches the routes.
The demo header scheme lives here; the JWT scheme is in the sibling `request_identity_jwt` so that module (which
imports starlette and ``kohaku.authz_jwt`` at import time) is only loaded when ``KOHAKU_AUTHZ=jwt`` selects it.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from kohaku.host_rest.deps import AuthHook, TenantHook
from kohaku.spec import Principal

if TYPE_CHECKING:
    # starlette is the "rest" extra; these appear in annotations only (stringified by `from __future__`).
    from starlette.requests import Request
    from starlette.responses import Response

    CallNext = Callable[[Request], Awaitable[Response]]
    HttpMiddleware = Callable[[Request, CallNext], Awaitable[Response]]


@dataclass(frozen=True)
class RequestIdentity:
    """How the REST host turns a request into a principal and a tenant."""

    auth: AuthHook
    tenant: TenantHook
    middleware: HttpMiddleware | None = None
    """Registered on ``{prefix}/*`` ahead of the routes when present (JWT verification + 401), except the data
    plane ``{prefix}/binding/*``, where the bearer token is the HMAC capability that host_rest verifies itself
    (see the mount in app.py)."""


def _demo_auth(request: Request) -> Principal:
    """Principal resolution (a product responsibility). In production, principal and roles are resolved from an
    authentication platform (JWT/OIDC, etc.).

    The demo substitutes the x-kohaku-role header, and no header (the default) is treated as admin (so as not to break
    the unauthenticated behavior of existing demos and existing tests; the legacy behavior where anyone passes the
    governance plane is reproduced with the admin role).
    """
    role = request.headers.get("x-kohaku-role") or "admin"
    return Principal(id=f"demo-{role}", roles=[role])


def _demo_tenant(request: Request) -> str | None:
    """Tenant resolution (a product responsibility). The demo looks at the x-kohaku-tenant header."""
    return request.headers.get("x-kohaku-tenant") or None


def create_header_identity() -> RequestIdentity:
    """The demo's header scheme (unchanged): x-kohaku-role (no header = admin) and x-kohaku-tenant."""
    return RequestIdentity(auth=_demo_auth, tenant=_demo_tenant)

"""Route registration entry point (the split counterpart of TS createKohakuRoutes / routes.ts).

register_routes composes the per-group registrars (compose / binding / governance / promotions / fixations,
mirroring packages/host-rest/src/routes/*.ts) in the same order the former monolithic `_fastapi_routes.py`
registered them, plus the /catalog route which — as in TS routes.ts — is not part of any group and stays
inline here. Route registration order can affect path matching, so this order is preserved exactly.
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI
from starlette.requests import Request
from starlette.responses import Response

from ..deps import KohakuHostDeps
from .binding import register_binding_routes
from .compose import register_compose_routes
from .fixations import register_fixation_routes
from .governance import register_governance_routes
from .promotions import register_promotion_routes
from .shared import (
    _LOGGER,
    BodyLimitASGIMiddleware,
    RequestIdASGIMiddleware,
    _json,
    _resolve_tenant,
)


def register_routes(app: FastAPI, deps: KohakuHostDeps, prefix: str = "/api/kohaku") -> FastAPI:
    """Include the REST profile routes into app as a prefixed APIRouter."""
    # Startup warning for the fail-open default of the governance/audit plane (allowed without authorization when
    # unwired), partial coverage. The fail-open default itself is intentional (backward compatible; governance authorization
    # is a product responsibility), but silently failing to notice an unprotected exposure is dangerous, so warn
    # exactly once. If protected by external middleware (a reverse proxy, etc.), this is expected.
    if deps.authorize_governance is None:
        _LOGGER.warning(
            "Governance/audit routes (/lineage, /telemetry, /promotions*, /fixations*) are exposed without "
            "authorization. In production, wiring deps.authorize_governance or protecting them with external "
            "middleware is mandatory."
        )
    # Symmetric startup warning: without deps.auth, every request is treated as the demo principal
    # (ANONYMOUS), so capability issuance, governance authorization, and audit records are all attributed to
    # one shared identity rather than the real caller. Fine for local development/demos, dangerous left
    # unwired in production.
    if deps.auth is None:
        _LOGGER.warning(
            "deps.auth is not wired. Every request will be treated as the demo principal (ANONYMOUS). "
            "In production, wiring deps.auth to real authentication is mandatory."
        )
    router = APIRouter(prefix=prefix)

    register_compose_routes(router, deps)
    register_binding_routes(router, deps)
    register_governance_routes(router, deps)
    register_promotion_routes(router, deps)
    register_fixation_routes(router, deps)

    # --- Catalog --------------------------------------------------------------
    @router.get("/catalog")
    async def catalog_route(request: Request) -> Response:
        tenant = await _resolve_tenant(deps, request)
        catalog = deps.compose.with_tenant_catalog(tenant).catalog
        defs = [
            {
                "type": d.type,
                "version": d.version,
                "description": d.description,
                "capabilities": d.capabilities.to_wire(),
                "implementation": d.implementation.to_wire(),
                "propsSchema": d.propsSchema.json_schema,
            }
            for d in catalog.list()
        ]
        return _json({"components": defs, "catalogVersion": catalog.fingerprint})

    app.include_router(router)
    # Per-request correlation id (ops): resolves it once per request and stamps X-Request-Id on every response
    # under `prefix`, success or failure — see RequestIdASGIMiddleware's docstring for why this is a pure ASGI
    # middleware rather than BaseHTTPMiddleware (streaming safety for /compose/stream's SSE).
    app.add_middleware(RequestIdASGIMiddleware, deps=deps, prefix=prefix)
    # Standard request-body size cap (a product may still layer its own limit in front of the mount point;
    # this is a bundled floor so a host that forgets to is not left fully unbounded). Starlette's
    # add_middleware prepends to the middleware list, and the list is wrapped outermost-last, so calling this
    # *after* RequestIdASGIMiddleware above makes BodyLimitASGIMiddleware the outermost of the two at request
    # time: an oversized body is rejected before request_id_of ever runs, matching TS's bodyLimit running
    # ahead of the request-id middleware in routes.ts.
    app.add_middleware(BodyLimitASGIMiddleware, deps=deps, prefix=prefix)
    return app

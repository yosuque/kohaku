"""The demo-only ``POST {prefix}/admin/bump-data-version`` route behind an identity scheme (port of the
``demoAdminRoutes`` route in apps/sample-api/src/app-core.ts).

Cache-busting is free LLM-spend amplification for anyone who can reach it, so under a real identity scheme (JWT) the
route is opt-in and, when registered, sits behind both the identity (401) and the governance RBAC (403, operation
``admin.bumpDataVersion`` -- admin's ``*`` pattern allows it, reviewer / viewer are denied by deny-by-default).
Authorization reuses the same ``authorize_governance`` hook host_rest's own routes check, and fails closed (denied)
if it is somehow unwired, unlike host_rest's fail-open default: this is a pure "spend the product's LLM budget"
lever, so "no policy wired" must not mean "allowed".

This module deliberately has no ``from __future__ import annotations``: FastAPI resolves a route parameter's
annotation against the defining module's globals, and ``Request`` has to be a real name there (the rest of the
sample keeps starlette out of its module globals so it imports without the ``rest`` extra).
"""

import inspect
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.requests import Request

from kohaku.host_rest import GovernanceOperation, error_body
from kohaku.host_rest.deps import AuthHook, AuthorizeGovernanceHook, TenantHook


async def _resolved(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def attach_bump_data_version_route(
    app: FastAPI,
    *,
    path: str,
    auth: AuthHook,
    tenant: TenantHook,
    authorize_governance: AuthorizeGovernanceHook | None,
    bump: Callable[[], str],
) -> None:
    @app.post(path)
    async def bump_data_version(request: Request) -> JSONResponse:
        principal = await _resolved(auth(request))
        if principal is None:
            return JSONResponse(
                error_body("CAPABILITY_DENIED", "authentication required"), status_code=401
            )
        resolved_tenant = await _resolved(tenant(request))
        allowed = (
            authorize_governance is not None
            and await _resolved(
                authorize_governance(
                    principal, GovernanceOperation(kind="admin.bumpDataVersion"), resolved_tenant
                )
            )
            is True
        )
        if not allowed:
            return JSONResponse(
                error_body(
                    "CAPABILITY_DENIED",
                    'governance operation "admin.bumpDataVersion" was not authorized',
                ),
                status_code=403,
            )
        return JSONResponse({"dataVersion": bump()})

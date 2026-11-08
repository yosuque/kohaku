"""SPEC CAP-TEN-002 on the MCP data plane (pytest counterpart of
packages/host-mcp-apps/test/capability-tenant.test.ts).

The profile resolves no tenant of its own, but it must not discard the tenant a verified capability binds
(e.g. one minted by the REST host and replayed here): it reaches DomainPort.invoke, the action gate's approval
binding and the audit records. A tenant-less capability behaves exactly as before.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from kohaku.host_core import PolicyRateLimiter, PolicyRateLimiterTakeParams, RateLimitedInfo
from kohaku.host_mcp import AttachOptions, McpHostDeps
from kohaku.spec import (
    ApprovalGrant,
    ApprovalVerifyResult,
    InvocationContext,
    OperationDescriptor,
    Principal,
    RateLimitResult,
    VerifyRequest,
    VerifyResult,
)

from ._helpers import DATA, RENDERER_HTML_PLAIN, TREND_REF, connect, make_compose_ctx

try:
    from mcp.server.lowlevel.server import Server  # noqa: F401
except ImportError:  # pragma: no cover
    pytest.skip("mcp is not installed", allow_module_level=True)

_OPTIONS = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)


class _Authz:
    def __init__(self, tenant: str | None) -> None:
        self._tenant = tenant

    async def issue_capability(
        self,
        principal: Principal,
        scopes: list[Any],
        *,
        ttl_seconds: int | None = None,
        tenant: str | None = None,
    ) -> str:
        return "cap"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=True, principal=Principal(id="req"), tenant=self._tenant)


class _Domain:
    def __init__(self) -> None:
        self.contexts: list[InvocationContext] = []

    async def list_operations(self) -> list[OperationDescriptor]:
        return [OperationDescriptor(name="delete", description="d", tier="approve")]

    async def invoke(self, op: str, args: Any, ctx: InvocationContext) -> object:
        self.contexts.append(ctx)
        return DATA if op == "trend" else {"ok": True}


class _Approvals:
    def __init__(self) -> None:
        self.verify_kwargs: list[dict[str, Any]] = []

    async def issue_approval(self, **kwargs: Any) -> str:
        raise AssertionError("not used")

    async def verify_approval(self, token: str, **kwargs: Any) -> ApprovalVerifyResult:
        self.verify_kwargs.append(kwargs)
        return ApprovalVerifyResult(
            ok=True,
            grant=ApprovalGrant(
                action=kwargs["action"],
                payloadHash=kwargs["payload_hash"],
                approverId="approver",
                requesterId=kwargs["requester_id"],
                exp=9999999999,
                jti="j",
            ),
        )


class _Recorder:
    def __init__(self) -> None:
        self.invoked_calls: list[dict[str, Any]] = []

    async def invoked(self, **kwargs: Any) -> None:
        self.invoked_calls.append(kwargs)

    async def denied(self, **kwargs: Any) -> None: ...

    async def approval_requested(self, **kwargs: Any) -> None: ...

    async def approved(self, **kwargs: Any) -> None: ...


class TestMcpCarriesTheCapabilityTenant:
    def test_resolve_binding_passes_a_rest_issued_capability_tenant_to_domain_invoke(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _Domain()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz("A"),
                query_source="sales",
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": TREND_REF, "capability": "cap"}
                )
                assert not res.is_error
            assert domain.contexts[0].tenant == "A"

        asyncio.run(run())

    def test_resolve_binding_with_a_tenant_less_capability_leaves_the_tenant_unset(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _Domain()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(None),
                query_source="sales",
            )
            async with connect(deps, _OPTIONS) as client:
                await client.call_tool(
                    "kohaku_resolve_binding", {"ref": TREND_REF, "capability": "cap"}
                )
            assert domain.contexts[0].tenant is None

        asyncio.run(run())

    def test_action_scopes_the_approval_binding_audit_and_invoke_by_the_capability_tenant(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain, approvals, recorder = _Domain(), _Approvals(), _Recorder()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz("A"),
                query_source="sales",
                approvals=approvals,
                action_audit_recorder=recorder,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_action",
                    {"action": "delete", "payload": {}, "capability": "cap", "approval": "tok"},
                )
                assert not res.is_error
            assert approvals.verify_kwargs[0]["tenant"] == "A"
            assert recorder.invoked_calls[0]["tenant"] == "A"
            assert domain.contexts[0].tenant == "A"

        asyncio.run(run())

    def test_action_with_a_tenant_less_capability_sends_no_tenant_anywhere(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain, approvals = _Domain(), _Approvals()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(None),
                query_source="sales",
                approvals=approvals,
            )
            async with connect(deps, _OPTIONS) as client:
                await client.call_tool(
                    "kohaku_action",
                    {"action": "delete", "payload": {}, "capability": "cap", "approval": "tok"},
                )
            assert approvals.verify_kwargs[0]["tenant"] is None
            assert domain.contexts[0].tenant is None

        asyncio.run(run())


class _TenantRuleLimiter(PolicyRateLimiter):
    """Denies only tenant "A" (a tenant-only rule such as policy `tenants.A.rateLimits`); records every take."""

    def __init__(self) -> None:
        self.calls: list[PolicyRateLimiterTakeParams] = []

    async def take(self, params: PolicyRateLimiterTakeParams) -> RateLimitResult:
        self.calls.append(params)
        if params.tenant == "A":
            return RateLimitResult(allow=False, retryAfterMs=500)
        return RateLimitResult(allow=True)


class _DenyAuthz(_Authz):
    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=False, reason="bad")


class TestRateLimitIsKeyedByTheCapabilityTenant:
    """SPEC CAP-TEN-002: the data-plane rate limit is taken after the capability verified and keyed by its
    tenant, so a tenant-scoped rule is enforced over MCP too."""

    def test_resolve_binding_takes_with_the_capability_tenant_and_a_tenant_a_rule_denies(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain, limiter = _Domain(), _TenantRuleLimiter()
            seen: list[RateLimitedInfo] = []
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz("A"),
                query_source="sales",
                rate_limiter=limiter,
                on_rate_limited=seen.append,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": TREND_REF, "capability": "cap"}
                )
                assert res.is_error
                assert (res.structured_content or {})["error"]["code"] == "RATE_LIMITED"
            assert len(limiter.calls) == 1
            assert limiter.calls[0].tenant == "A"
            assert limiter.calls[0].routeClass == "resolve"
            assert domain.contexts == []
            assert [(i.tenant, i.routeClass) for i in seen] == [("A", "resolve")]

        asyncio.run(run())

    def test_action_takes_with_the_capability_tenant_and_a_tenant_a_rule_denies(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain, limiter = _Domain(), _TenantRuleLimiter()
            seen: list[RateLimitedInfo] = []
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz("A"),
                query_source="sales",
                rate_limiter=limiter,
                on_rate_limited=seen.append,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_action", {"action": "delete", "payload": {}, "capability": "cap"}
                )
                assert res.is_error
                assert (res.structured_content or {})["error"]["code"] == "RATE_LIMITED"
            assert len(limiter.calls) == 1
            assert limiter.calls[0].tenant == "A"
            assert limiter.calls[0].routeClass == "action"
            assert domain.contexts == []
            assert [(i.tenant, i.routeClass) for i in seen] == [("A", "action")]

        asyncio.run(run())

    def test_a_tenant_less_capability_is_taken_without_a_tenant(self, tmp_path: Path) -> None:
        async def run() -> None:
            limiter = _TenantRuleLimiter()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=_Domain(),
                authz=_Authz(None),
                query_source="sales",
                rate_limiter=limiter,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": TREND_REF, "capability": "cap"}
                )
                assert not res.is_error
            assert limiter.calls[0].tenant is None

        asyncio.run(run())

    def test_a_capability_that_fails_verification_is_refused_before_the_limiter(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            limiter = _TenantRuleLimiter()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=_Domain(),
                authz=_DenyAuthz(None),
                query_source="sales",
                rate_limiter=limiter,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": TREND_REF, "capability": "cap"}
                )
                assert res.is_error
            assert limiter.calls == []

        asyncio.run(run())

    def test_action_with_a_capability_that_fails_verification_never_reaches_the_limiter(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            limiter = _TenantRuleLimiter()
            seen: list[RateLimitedInfo] = []
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=_Domain(),
                authz=_DenyAuthz(None),
                query_source="sales",
                rate_limiter=limiter,
                on_rate_limited=seen.append,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_action", {"action": "delete", "payload": {}, "capability": "cap"}
                )
                assert res.is_error
                assert (res.structured_content or {}).get("error", {}).get("code") != "RATE_LIMITED"
            assert limiter.calls == []
            assert seen == []

        asyncio.run(run())

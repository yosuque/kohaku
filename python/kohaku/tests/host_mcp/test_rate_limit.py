"""McpHostDeps.rate_limiter (pytest counterpart of TS packages/host-mcp-apps/test/rate-limit.test.ts,
adapted to tool calls).

Uses a stub PolicyRateLimiter (a subclass overriding take() without wiring a real store/policy file,
mirroring host_rest's test_rate_limit_middleware.py) -- this module tests only the tool-call wiring
(which handlers call _check_mcp_rate_limit, with which route_class, and how a denial is turned into a
structured tool error), not PolicyRuntime's own rate-limit resolution logic (covered by test_policy.py).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from kohaku.host_core import PolicyRateLimiter, PolicyRateLimiterTakeParams
from kohaku.host_mcp import AttachOptions, McpHostDeps
from kohaku.spec import OperationDescriptor, Principal, RateLimitResult

from ._helpers import (
    DATA,
    RENDERER_HTML_PLAIN,
    TREND_REF,
    connect,
    make_compose_ctx,
    request_meta,
)

try:
    from mcp.server.lowlevel.server import Server  # noqa: F401
except ImportError:  # pragma: no cover
    pytest.skip("mcp is not installed", allow_module_level=True)

_OPTIONS = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)


class _StubRateLimiter(PolicyRateLimiter):
    """A rate limiter stub whose take() always returns `result` and records every call."""

    def __init__(self, result: RateLimitResult) -> None:
        self.result = result
        self.calls: list[PolicyRateLimiterTakeParams] = []

    async def take(self, params: PolicyRateLimiterTakeParams) -> RateLimitResult:
        self.calls.append(params)
        return self.result


class _SimpleAuthz:
    async def issue_capability(
        self, principal: Principal, scopes: list[Any], *, ttl_seconds: int | None = None
    ) -> str:
        return "cap"

    async def verify(self, token: str, req: Any) -> Any:
        from kohaku.spec import VerifyResult

        return VerifyResult(ok=True, principal=None, reason=None)


class _RecordingDomain:
    def __init__(self, operations: list[OperationDescriptor] | None = None) -> None:
        self._operations = operations or []

    async def list_operations(self) -> list[OperationDescriptor]:
        return self._operations

    async def invoke(self, op: str, args: Any, ctx: Any) -> object:
        if op == "trend":
            return DATA
        if op == "annotate":
            return {"ok": True}
        raise ValueError(f"unknown op {op}")


def _base_deps(tmp_path: Path, **overrides: Any) -> McpHostDeps:
    return McpHostDeps(
        compose=make_compose_ctx(tmp_path),
        domain=_RecordingDomain(operations=[OperationDescriptor(name="annotate", description="write")]),
        authz=_SimpleAuthz(),
        query_source="sales",
        **overrides,
    )


class TestBackwardCompatibility:
    def test_does_not_affect_kohaku_compose_when_rate_limiter_is_unset(self, tmp_path: Path) -> None:
        async def run() -> None:
            deps = _base_deps(tmp_path)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert not result.is_error

        asyncio.run(run())


class TestDenial:
    def test_returns_a_structured_rate_limited_tool_error_with_retry_after_ms(self, tmp_path: Path) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=False, retryAfterMs=2500))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert result.is_error is True
                assert result.structured_content == {
                    "error": {"code": "RATE_LIMITED", "message": "rate limit exceeded", "retryAfterMs": 2500}
                }

        asyncio.run(run())

    def test_returns_a_structured_rate_limited_tool_error_without_retry_after_ms_when_not_given(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=False))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert result.is_error is True
                assert result.structured_content == {
                    "error": {"code": "RATE_LIMITED", "message": "rate limit exceeded"}
                }

        asyncio.run(run())

    def test_denies_kohaku_action_with_route_class_action(self, tmp_path: Path) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=False, retryAfterMs=1000))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_action", {"action": "annotate", "payload": {}, "capability": "cap"}
                )
                assert result.is_error is True
            assert limiter.calls[0].routeClass == "action"

        asyncio.run(run())

    def test_denies_kohaku_resolve_binding_with_route_class_resolve(self, tmp_path: Path) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=False, retryAfterMs=1000))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": TREND_REF, "capability": "cap"}
                )
                assert result.is_error is True
            assert limiter.calls[0].routeClass == "resolve"

        asyncio.run(run())

    def test_denies_kohaku_event_with_route_class_compose(self, tmp_path: Path) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=False, retryAfterMs=1000))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {}},
                        "on": "c.pointClick",
                        "payload": {},
                    },
                )
                assert result.is_error is True
            assert limiter.calls[0].routeClass == "compose"

        asyncio.run(run())


class TestAllow:
    def test_lets_the_request_through_and_the_handler_still_runs(self, tmp_path: Path) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=True))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert not result.is_error
                spec = result.structured_content["spec"]
                assert spec["provenance"]["tier"] == "L0"

        asyncio.run(run())


class TestBucketKey:
    def test_keys_the_bucket_by_the_resolved_principal_id_when_resolve_principal_is_wired(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=True))

            def resolve_principal(ctx: Any) -> Principal:
                principal_id = (ctx.meta or {}).get("principal") if ctx is not None else None
                return Principal(id=str(principal_id) if principal_id is not None else "anon")

            deps = _base_deps(tmp_path, rate_limiter=limiter, resolve_principal=resolve_principal)
            async with connect(deps, _OPTIONS) as client:
                await client.call_tool(
                    "kohaku_compose",
                    {"question": "Monthly sales trend"},
                    meta=request_meta(principal="alice"),
                )
                await client.call_tool(
                    "kohaku_compose",
                    {"question": "Monthly sales trend"},
                    meta=request_meta(principal="bob"),
                )
            assert [c.principal for c in limiter.calls] == ["alice", "bob"]
            assert all(c.tenant is None for c in limiter.calls)

        asyncio.run(run())

    def test_falls_back_to_the_literal_anonymous_when_resolve_principal_is_unset(
        self, tmp_path: Path
    ) -> None:
        """Unlike the TS port, Python has no further sessionId fallback step (see
        _mcp_rate_limit_key's doc comment for the documented SDK-accessor gap this reflects) --
        the constant fallback principal id ("mcp-user") is never used as the bucket key either way."""

        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=True))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
            assert limiter.calls[0].principal == "anonymous"

        asyncio.run(run())

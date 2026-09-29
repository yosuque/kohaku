"""McpHostDeps.rate_limiter (pytest counterpart of TS packages/host-mcp-apps/test/rate-limit.test.ts,
adapted to tool calls).

Uses a stub PolicyRateLimiter (a subclass overriding take() without wiring a real store/policy file,
mirroring host_rest's test_rate_limit_middleware.py) -- this module tests only the tool-call wiring
(which handlers call _check_mcp_rate_limit, with which route_class, and how a denial is turned into a
structured tool error), not PolicyRuntime's own rate-limit resolution logic (covered by test_policy.py).
"""

from __future__ import annotations

import asyncio
import warnings
from pathlib import Path
from typing import Any

import pytest

from kohaku.host_core import PolicyRateLimiter, PolicyRateLimiterTakeParams, RateLimitedInfo
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

    def test_falls_back_to_a_stable_per_connection_id_when_resolve_principal_is_unset(
        self, tmp_path: Path
    ) -> None:
        """When resolve_principal is unset, the constant fallback principal id ("mcp-user") is never
        used as the bucket key (every anonymous caller would otherwise share one bucket) -- instead it
        falls back to _session_correlation_prefix's stable per-connection opaque id (the same anchor
        the MCP correlation-id work (design.md #54) established), which two calls on the *same* connection share."""

        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=True))
            deps = _base_deps(tmp_path, rate_limiter=limiter)
            async with connect(deps, _OPTIONS) as client:
                await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
            assert limiter.calls[0].principal != "mcp-user"
            assert limiter.calls[0].principal == limiter.calls[1].principal

        asyncio.run(run())


class TestRateLimitKeyHook:
    def test_keys_the_bucket_by_rate_limit_key_taking_precedence_over_resolve_principal(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=True))

            async def rate_limit_key(ctx: Any) -> str:
                return f"ip:{(ctx.meta or {}).get('ip', 'unknown')}"

            deps = _base_deps(
                tmp_path,
                rate_limiter=limiter,
                resolve_principal=lambda _ctx: Principal(id="principal-id"),
                rate_limit_key=rate_limit_key,
            )
            async with connect(deps, _OPTIONS) as client:
                await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}, meta=request_meta(ip="10.0.0.1")
                )
                await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}, meta=request_meta(ip="10.0.0.2")
                )
            assert [c.principal for c in limiter.calls] == ["ip:10.0.0.1", "ip:10.0.0.2"]

        asyncio.run(run())

    def test_a_raising_rate_limit_key_is_fail_closed(self, tmp_path: Path) -> None:
        async def run() -> None:
            limiter = _StubRateLimiter(RateLimitResult(allow=True))
            errors: list[Any] = []

            def rate_limit_key(_ctx: Any) -> str:
                raise RuntimeError("key lookup down")

            deps = _base_deps(
                tmp_path, rate_limiter=limiter, rate_limit_key=rate_limit_key, on_error=errors.append
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
            assert result.is_error is True
            assert limiter.calls == []
            assert len(errors) == 1
            assert errors[0].endpoint == "kohaku_compose"

        asyncio.run(run())


class TestOnRateLimited:
    def test_is_notified_on_denial_with_the_bucket_key_and_correlation_id_and_not_on_an_allowed_call(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            seen: list[RateLimitedInfo] = []
            denied_deps = _base_deps(
                tmp_path,
                rate_limiter=_StubRateLimiter(RateLimitResult(allow=False, retryAfterMs=1000)),
                rate_limit_key=lambda _ctx: "client-7",
                on_rate_limited=seen.append,
            )
            async with connect(denied_deps, _OPTIONS) as client:
                await client.call_tool(
                    "kohaku_action", {"action": "annotate", "payload": {}, "capability": "cap"}
                )
            assert len(seen) == 1
            assert seen[0].principal == "client-7"
            assert seen[0].routeClass == "action"
            assert seen[0].requestId.startswith("mcp:")

            allowed_seen: list[RateLimitedInfo] = []
            allowed_deps = _base_deps(
                tmp_path,
                rate_limiter=_StubRateLimiter(RateLimitResult(allow=True)),
                on_rate_limited=allowed_seen.append,
            )
            async with connect(allowed_deps, _OPTIONS) as client:
                await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
            assert allowed_seen == []

        asyncio.run(run())


class TestUnkeyedLimiterWarning:
    def test_warns_once_per_process_when_the_limiter_has_neither_resolve_principal_nor_rate_limit_key(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from kohaku.host_mcp import server as server_module

        monkeypatch.setattr(server_module, "_warned_unkeyed_rate_limiter", False)
        limiter = _StubRateLimiter(RateLimitResult(allow=True))
        with pytest.warns(UserWarning, match="rate_limit_key"):
            server_module._warn_unkeyed_rate_limiter(_base_deps(tmp_path, rate_limiter=limiter))
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            server_module._warn_unkeyed_rate_limiter(_base_deps(tmp_path, rate_limiter=limiter))  # second: silent

    def test_stays_silent_when_the_limiter_is_keyed_or_absent(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from kohaku.host_mcp import server as server_module

        limiter = _StubRateLimiter(RateLimitResult(allow=True))
        for overrides in (
            {"rate_limiter": limiter, "resolve_principal": lambda _ctx: Principal(id="u")},
            {"rate_limiter": limiter, "rate_limit_key": lambda _ctx: "k"},
            {},
        ):
            monkeypatch.setattr(server_module, "_warned_unkeyed_rate_limiter", False)
            with warnings.catch_warnings():
                warnings.simplefilter("error")
                server_module._warn_unkeyed_rate_limiter(_base_deps(tmp_path, **overrides))

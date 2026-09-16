"""Per-tool-call principal resolution (McpHostDeps.resolve_principal).

pytest counterpart of TS packages/host-mcp-apps/test/principal.test.ts. `resolve_principal` is resolved once
per tool call, inside the tool handler itself, before capability issuance / SessionContext.principal / the
initial-data preresolution's domain.invoke calls ever see it. Fallback order: resolve_principal(ctx) ->
deps.principal -> the built-in anonymous principal. A raise from resolve_principal is fail-closed (isError +
on_error), never silently downgraded to anonymous.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_mcp import AttachOptions, McpErrorInfo, McpHostDeps
from kohaku.llm import FakeLlm
from kohaku.spec import (
    Intent,
    IntentInput,
    InvocationContext,
    OperationDescriptor,
    Principal,
    QueryHandle,
    SessionContext,
    VerifyRequest,
    VerifyResult,
)

from ._helpers import (
    CATALOG,
    DATA,
    RENDERER_HTML_PLAIN,
    TREND_REF,
    _fixed_source,
    connect,
    make_compose_ctx,
    trend_spec_builder,
)

try:
    from mcp.server.lowlevel.server import Server  # noqa: F401
except ImportError:  # pragma: no cover
    pytest.skip("mcp is not installed", allow_module_level=True)

_OPTIONS = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)


class _CapturingSemantic:
    """Deterministic SemanticPort that records the SessionContext (including .principal) of each normalize
    call (mirrors test_locale.py's _CapturingSemantic, duplicated locally for the same reason that file
    duplicates it rather than sharing one across test modules — kept next to the test that needs it)."""

    def __init__(self, sessions: list[SessionContext]) -> None:
        self.sessions = sessions

    async def normalize(self, input: Any, ctx: SessionContext) -> IntentInput:
        self.sessions.append(ctx)
        return IntentInput(canonical="sales.trend", params={})

    async def resolve_query(self, intent: Intent, *, tenant: str | None = None) -> QueryHandle:
        return QueryHandle(uri=TREND_REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@seed-1"

    async def describe_shape(self, handle: QueryHandle) -> None:
        return None


def _capturing_compose_ctx(tmp_path: Path, sessions: list[SessionContext]) -> ComposeContext:
    from kohaku.storage import FileStoragePort

    return ComposeContext(
        catalog=CATALOG,
        semantic=_CapturingSemantic(sessions),
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(),
        policy=ComposePolicy(fixedSpecs=_fixed_source(trend_spec_builder)),
    )


class _RecordingDomain:
    """A DomainPort that records the principal each invoke call carried (same shape as _helpers.TrendDomain,
    plus a capture list and an optional operations list for the kohaku_action tests)."""

    def __init__(self, operations: list[OperationDescriptor] | None = None) -> None:
        self.principals: list[str] = []
        self._operations = operations or []

    async def list_operations(self) -> list[OperationDescriptor]:
        return self._operations

    async def invoke(self, op: str, args: Any, ctx: InvocationContext) -> object:
        self.principals.append(ctx.principal.id)
        if op == "trend":
            return DATA
        if op == "annotate":
            return {"ok": True}
        raise ValueError(f"unknown op {op}")


class _RecordingAuthz:
    """An AuthzPort that always accepts. issue_capability records the principal it was called with;
    verify deliberately never returns a principal, so every verdict.principal-or-fallback call site in
    server.py is exercised whenever a call succeeds (same rationale as _helpers.SimpleAuthz, but verify
    here is unconditional rather than prefix-matched — these tests are about principal propagation, not
    authorization semantics, which mcp.test.py / test_mcp.py already cover)."""

    def __init__(self) -> None:
        self.issued_for: list[str] = []

    async def issue_capability(
        self, principal: Principal, scopes: list[Any], *, ttl_seconds: int | None = None
    ) -> str:
        self.issued_for.append(principal.id)
        return "cap:" + "|".join(s.ref for s in scopes)

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=True, principal=None, reason=None)


def _meta_principal_resolver(*, sync: bool) -> Any:
    """A resolve_principal reading `_meta.principal` off the request context (falls back to "anon" when
    absent) — the plan's exact shape (`getattr(ctx.meta, "principal", None)`), in both sync and async form."""

    def _resolve(ctx: Any) -> Principal:
        principal_id = getattr(ctx.meta, "principal", None) if ctx is not None else None
        return Principal(id=str(principal_id) if principal_id is not None else "anon")

    if sync:
        return _resolve

    async def _resolve_async(ctx: Any) -> Principal:
        return _resolve(ctx)

    return _resolve_async


class TestPerCallPrincipalResolution:
    def test_sync_resolver_two_callers_on_one_connection_each_get_their_own_principal(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            authz = _RecordingAuthz()
            domain = _RecordingDomain()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=authz,
                query_source="sales",
                resolve_principal=_meta_principal_resolver(sync=True),
            )
            async with connect(deps, _OPTIONS) as client:
                alice = await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}, meta={"principal": "alice"}
                )
                assert not alice.isError
                bob = await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}, meta={"principal": "bob"}
                )
                assert not bob.isError

            assert authz.issued_for == ["alice", "bob"]
            assert domain.principals == ["alice", "bob"]

        asyncio.run(run())

    def test_async_resolver_kohaku_resolve_binding_falls_back_to_the_per_call_principal(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _RecordingDomain()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_RecordingAuthz(),
                query_source="sales",
                resolve_principal=_meta_principal_resolver(sync=False),
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_resolve_binding",
                    {"ref": TREND_REF, "capability": "cap"},
                    meta={"principal": "alice"},
                )
                assert not result.isError

            assert domain.principals == ["alice"]

        asyncio.run(run())

    def test_kohaku_action_falls_back_to_the_per_call_principal(self, tmp_path: Path) -> None:
        async def run() -> None:
            domain = _RecordingDomain(
                operations=[OperationDescriptor(name="annotate", description="annotate (write)")]
            )
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_RecordingAuthz(),
                query_source="sales",
                resolve_principal=_meta_principal_resolver(sync=True),
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_action",
                    {"action": "annotate", "payload": {}, "capability": "cap"},
                    meta={"principal": "bob"},
                )
                assert not result.isError

            assert domain.principals == ["bob"]

        asyncio.run(run())

    def test_kohaku_event_rides_the_normalize_session(self, tmp_path: Path) -> None:
        async def run() -> None:
            sessions: list[SessionContext] = []
            domain = _RecordingDomain()
            deps = McpHostDeps(
                compose=_capturing_compose_ctx(tmp_path, sessions),
                domain=domain,
                authz=_RecordingAuthz(),
                query_source="sales",
                resolve_principal=_meta_principal_resolver(sync=True),
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {}},
                        "on": "c.pointClick",
                        "payload": {},
                    },
                    meta={"principal": "carol"},
                )
                assert not result.isError

            assert sessions[0].surface == "mcp-app"
            assert sessions[0].principal is not None
            assert sessions[0].principal.id == "carol"
            # The recompose after kohaku_event's own normalize call still preresolves the recomposed Spec's
            # data via domain.invoke, under the same resolved principal.
            assert domain.principals == ["carol"]

        asyncio.run(run())


class TestFallbackOrder:
    def test_unwired_resolve_principal_no_deps_principal_falls_back_to_the_built_in_anonymous_principal(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            authz = _RecordingAuthz()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=_RecordingDomain(),
                authz=authz,
                query_source="sales",
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert not result.isError

            assert authz.issued_for == ["mcp-user"]

        asyncio.run(run())

    def test_unwired_resolve_principal_with_deps_principal_set_falls_back_to_that_principal(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            authz = _RecordingAuthz()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=_RecordingDomain(),
                authz=authz,
                query_source="sales",
                principal=Principal(id="svc-account"),
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert not result.isError

            assert authz.issued_for == ["svc-account"]

        asyncio.run(run())


class TestFailClosed:
    def test_a_raising_resolve_principal_is_fail_closed(self, tmp_path: Path) -> None:
        async def run() -> None:
            domain_calls: list[str] = []
            on_error_calls: list[McpErrorInfo] = []

            class _Domain:
                async def list_operations(self) -> list[OperationDescriptor]:
                    return []

                async def invoke(self, op: str, args: Any, ctx: InvocationContext) -> object:
                    domain_calls.append(op)
                    return DATA

            class _Authz:
                async def issue_capability(
                    self, principal: Principal, scopes: list[Any], *, ttl_seconds: int | None = None
                ) -> str:
                    raise AssertionError("must not be called: resolve_principal already failed")

                async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
                    raise AssertionError("must not be called: resolve_principal already failed")

            def _raising_resolver(ctx: Any) -> Principal:
                raise RuntimeError("identity provider unavailable")

            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=_Domain(),
                authz=_Authz(),
                query_source="sales",
                resolve_principal=_raising_resolver,
                on_error=lambda info: on_error_calls.append(info),
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})

            assert result.isError is True
            # A plain (untyped) raised exception never echoes its own message back to the caller
            # (kohaku.host_core.is_typed_host_error) — same rule as every other _safe_tool-caught failure.
            text = result.content[0].text  # type: ignore[union-attr]
            assert text == "internal error; see the observability hook (on_error) for details"
            assert domain_calls == []
            assert len(on_error_calls) == 1
            assert on_error_calls[0].endpoint == "kohaku_compose"
            assert isinstance(on_error_calls[0].error, RuntimeError)

        asyncio.run(run())

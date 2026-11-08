"""SPEC ACT-RD-001 (design.md #77) on the MCP profile: `kohaku_resolve_binding` and the initial-data
pre-resolution never execute an operation whose declared tier is "confirm" or "approve" (pytest counterpart of
packages/host-mcp-apps/test/gated-read.test.ts).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from kohaku.host_core import create_operation_index
from kohaku.host_mcp import AttachOptions, McpHostDeps
from kohaku.host_mcp.initial_data import PreresolveContext, _preresolve_initial_data
from kohaku.host_mcp.server import SnapshotRefNotReadableError, _snapshot_html_for
from kohaku.spec import (
    IntentInput,
    InvocationContext,
    JsonObject,
    OperationDescriptor,
    Principal,
    UISpec,
    VerifyRequest,
    VerifyResult,
    finalize_intent,
)

from ._helpers import DATA, RENDERER_HTML_PLAIN, connect, make_compose_ctx

try:
    from mcp.server.lowlevel.server import Server  # noqa: F401
except ImportError:  # pragma: no cover
    pytest.skip("mcp is not installed", allow_module_level=True)

_OPTIONS = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
_PRINCIPAL = Principal(id="u1", roles=["user"])


class _Authz:
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
        return VerifyResult(ok=True, principal=_PRINCIPAL)


class _Domain:
    def __init__(self, *ops: OperationDescriptor) -> None:
        self._ops = list(ops)
        self.invoke_calls: list[str] = []

    async def list_operations(self) -> list[OperationDescriptor]:
        return self._ops

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        self.invoke_calls.append(op)
        return DATA


class _BrokenIndexDomain(_Domain):
    async def list_operations(self) -> list[OperationDescriptor]:
        raise RuntimeError("domain unavailable (test)")


class _Recorder:
    def __init__(self) -> None:
        self.denied_calls: list[dict[str, Any]] = []

    async def invoked(self, **kwargs: Any) -> None: ...

    async def denied(self, **kwargs: Any) -> None:
        self.denied_calls.append(kwargs)

    async def approval_requested(self, **kwargs: Any) -> None: ...

    async def approved(self, **kwargs: Any) -> None: ...


def _text(res: Any) -> str:
    return str(res.content[0].text)


class TestResolveBindingTool:
    @pytest.mark.parametrize("tier", ["approve", "confirm"])
    def test_a_ref_naming_a_gated_operation_is_a_tool_error_and_domain_invoke_is_not_called(
        self, tmp_path: Path, tier: str
    ) -> None:
        async def run() -> None:
            domain = _Domain(OperationDescriptor(name="purge", description="d", tier=tier))  # type: ignore[arg-type]
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(),
                query_source="sales",
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding",
                    {"ref": "query://sales/purge?fy=2026", "capability": "cap"},
                )
                assert res.is_error
                assert _text(res) == "capability denied: gated operation is not readable"
            assert domain.invoke_calls == []

        asyncio.run(run())

    def test_records_action_denied_with_the_descriptor_tier_and_the_fixed_reason(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _Domain(OperationDescriptor(name="purge", description="d", tier="approve"))
            recorder = _Recorder()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(),
                query_source="sales",
                action_audit_recorder=recorder,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": "query://sales/purge", "capability": "cap"}
                )
                assert res.is_error
            assert len(recorder.denied_calls) == 1
            call = recorder.denied_calls[0]
            assert call["action"] == "purge"
            assert call["tier"] == "approve"
            assert call["reason"] == "gated operation is not readable"
            assert call["principal"].id == "u1"
            assert domain.invoke_calls == []

        asyncio.run(run())

    def test_a_tier_less_operation_and_a_tier_auto_operation_stay_readable(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _Domain(
                OperationDescriptor(name="records", description="d"),
                OperationDescriptor(name="trend", description="d", tier="auto"),
            )
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(),
                query_source="sales",
            )
            async with connect(deps, _OPTIONS) as client:
                for op in ("records", "trend"):
                    res = await client.call_tool(
                        "kohaku_resolve_binding",
                        {"ref": f"query://sales/{op}", "capability": "cap"},
                    )
                    assert not res.is_error
            assert domain.invoke_calls == ["records", "trend"]

        asyncio.run(run())

    def test_an_unreadable_operation_index_fails_closed_with_a_tool_error(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _BrokenIndexDomain()
            recorder = _Recorder()
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(),
                query_source="sales",
                action_audit_recorder=recorder,
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": "query://sales/records", "capability": "cap"}
                )
                assert res.is_error
                assert "operation index unavailable" in _text(res)
            assert domain.invoke_calls == []
            assert len(recorder.denied_calls) == 1
            assert recorder.denied_calls[0]["action"] == "records"
            assert recorder.denied_calls[0]["tier"] == "auto"
            assert recorder.denied_calls[0]["reason"] == "action gate unavailable"

        asyncio.run(run())

    def test_a_tier_less_operation_with_an_invalid_params_schema_is_refused_too(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _Domain(
                OperationDescriptor(
                    name="odd", description="d", paramsSchema={"type": "object", "$ref": "#/nope"}
                )
            )
            seen: list[str] = []
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(),
                query_source="sales",
                on_error=lambda info: seen.append(info.endpoint),
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": "query://sales/odd", "capability": "cap"}
                )
                assert res.is_error
                assert _text(res) == "action parameter schema unavailable"
            assert domain.invoke_calls == []
            assert "kohaku_resolve_binding.operationIndex" in seen

        asyncio.run(run())

    def test_a_throwing_recorder_does_not_change_the_denial(self, tmp_path: Path) -> None:
        async def run() -> None:
            class _Throwing(_Recorder):
                async def denied(self, **kwargs: Any) -> None:
                    self.denied_calls.append(kwargs)
                    raise RuntimeError("audit store down (test)")

            domain = _Domain(OperationDescriptor(name="purge", description="d", tier="confirm"))
            recorder = _Throwing()
            seen: list[str] = []
            deps = McpHostDeps(
                compose=make_compose_ctx(tmp_path),
                domain=domain,
                authz=_Authz(),
                query_source="sales",
                action_audit_recorder=recorder,
                on_error=lambda info: seen.append(info.endpoint),
            )
            async with connect(deps, _OPTIONS) as client:
                res = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": "query://sales/purge", "capability": "cap"}
                )
                assert res.is_error
                assert _text(res) == "capability denied: gated operation is not readable"
            assert len(recorder.denied_calls) == 1
            assert "kohaku_resolve_binding.audit" in seen
            assert domain.invoke_calls == []

        asyncio.run(run())


def _spec_with(*refs: str) -> UISpec:
    intent = finalize_intent(IntentInput(canonical="sales.trend", params={}))
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": intent.to_wire(),
            "dataVersion": "x",
            "components": [
                {
                    "id": f"c{i}",
                    "type": "presentChart",
                    "props": {"kind": "line", "x": "month", "y": "revenue"},
                    "data": {"$ref": ref},
                }
                for i, ref in enumerate(refs)
            ],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
        }
    )


def _pctx(
    domain: _Domain,
    tmp_path: Path,
    *,
    recorder: _Recorder | None = None,
    on_error: Any = None,
) -> PreresolveContext:
    deps = McpHostDeps(
        compose=make_compose_ctx(tmp_path),
        domain=domain,
        authz=_Authz(),
        query_source="sales",
        action_audit_recorder=recorder,
        on_error=on_error,
    )
    return PreresolveContext(
        deps=deps,
        principal=_PRINCIPAL,
        operation_index=create_operation_index(domain),
        correlation_id="req-1",
    )


class TestInitialDataPreresolution:
    def test_skips_a_gated_ref_still_embeds_the_readable_ones_and_audits_the_denial(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _Domain(
                OperationDescriptor(name="purge", description="d", tier="approve"),
                OperationDescriptor(name="confirmed", description="d", tier="confirm"),
                OperationDescriptor(name="records", description="d"),
            )
            recorder = _Recorder()
            data, resolved, _denied = await _preresolve_initial_data(
                _spec_with(
                    "query://sales/purge", "query://sales/confirmed", "query://sales/records"
                ),
                _pctx(domain, tmp_path, recorder=recorder),
            )
            assert domain.invoke_calls == ["records"]
            assert list(data) == ["query://sales/records"]
            assert list(resolved) == ["query://sales/records"]
            assert {c["action"]: c["tier"] for c in recorder.denied_calls} == {
                "purge": "approve",
                "confirmed": "confirm",
            }
            assert all(
                c["reason"] == "gated operation is not readable" for c in recorder.denied_calls
            )

        asyncio.run(run())

    def test_an_unreadable_operation_index_embeds_nothing_and_reports_to_on_error(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _BrokenIndexDomain()
            seen: list[str] = []
            data, _resolved, _denied = await _preresolve_initial_data(
                _spec_with("query://sales/records"),
                _pctx(domain, tmp_path, on_error=lambda info: seen.append(info.endpoint)),
            )
            assert data == {}
            assert domain.invoke_calls == []
            assert "compose.initialData" in seen

        asyncio.run(run())

    def test_a_dead_list_operations_is_read_once_one_report_and_one_audit_record(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            class _Counting(_BrokenIndexDomain):
                calls = 0

                async def list_operations(self) -> list[OperationDescriptor]:
                    _Counting.calls += 1
                    raise RuntimeError("domain unavailable (test)")

            domain = _Counting()
            seen: list[str] = []
            recorder = _Recorder()
            data, _resolved, denied = await _preresolve_initial_data(
                _spec_with(
                    "query://sales/a", "query://sales/b", "query://sales/c", "query://sales/d"
                ),
                _pctx(
                    domain,
                    tmp_path,
                    recorder=recorder,
                    on_error=lambda info: seen.append(info.endpoint),
                ),
            )
            assert data == {}
            assert _Counting.calls == 1
            assert seen.count("compose.initialData") == 1
            assert len(recorder.denied_calls) == 1
            assert set(denied.values()) == {"indexUnavailable"}
            assert len(denied) == 4

        asyncio.run(run())

    def test_returns_the_refused_refs_with_their_reason(self, tmp_path: Path) -> None:
        async def run() -> None:
            domain = _Domain(
                OperationDescriptor(name="purge", description="d", tier="approve"),
                OperationDescriptor(
                    name="odd", description="d", paramsSchema={"type": "object", "$ref": "#/nope"}
                ),
                OperationDescriptor(name="records", description="d"),
            )
            _data, _resolved, denied = await _preresolve_initial_data(
                _spec_with("query://sales/purge", "query://sales/odd", "query://sales/records"),
                _pctx(domain, tmp_path),
            )
            assert denied == {
                "query://sales/purge": "gated",
                "query://sales/odd": "schemaInvalid",
            }

        asyncio.run(run())


class TestSnapshotPath:
    def test_standalone_names_the_cause_never_invokes_and_audits_once(self, tmp_path: Path) -> None:
        async def run() -> None:
            domain = _Domain(OperationDescriptor(name="purge", description="d", tier="approve"))
            recorder = _Recorder()
            result: Any = SimpleNamespace(spec=_spec_with("query://sales/purge"))
            with pytest.raises(SnapshotRefNotReadableError) as exc_info:
                await _snapshot_html_for(
                    result, _OPTIONS, _pctx(domain, tmp_path, recorder=recorder)
                )
            assert exc_info.value.code == "SNAPSHOT_REF_NOT_READABLE"
            assert "gated operation is not readable" in str(exc_info.value)
            assert domain.invoke_calls == []
            assert len(recorder.denied_calls) == 1

        asyncio.run(run())

    def test_after_a_preresolution_that_already_denied_the_ref_there_is_no_second_audit(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            domain = _Domain(OperationDescriptor(name="purge", description="d", tier="approve"))
            recorder = _Recorder()
            pctx = _pctx(domain, tmp_path, recorder=recorder)
            spec = _spec_with("query://sales/purge")
            _data, resolved, denied = await _preresolve_initial_data(spec, pctx)
            assert len(recorder.denied_calls) == 1
            result: Any = SimpleNamespace(spec=spec)
            with pytest.raises(SnapshotRefNotReadableError) as exc_info:
                await _snapshot_html_for(result, _OPTIONS, pctx, resolved, denied)
            assert "gated operation is not readable" in str(exc_info.value)
            assert len(recorder.denied_calls) == 1
            assert domain.invoke_calls == []

        asyncio.run(run())

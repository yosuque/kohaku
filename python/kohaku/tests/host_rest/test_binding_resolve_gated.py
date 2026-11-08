"""SPEC ACT-RD-001 (design.md #77): GET /binding/resolve never executes an operation whose declared tier is
"confirm" or "approve" (port of packages/host-rest/test/binding-resolve-gated.test.ts).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest

from kohaku.spec import InvocationContext, JsonObject, OperationDescriptor, Scope

from .conftest import PREFIX, Harness, build_harness


class _Domain:
    def __init__(self, *ops: OperationDescriptor) -> None:
        self._ops = list(ops)
        self.invoke_calls: list[str] = []

    async def list_operations(self) -> list[OperationDescriptor]:
        return self._ops

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        self.invoke_calls.append(op)
        return {"columns": [], "rows": [], "dataVersion": "v1"}


class _BrokenIndexDomain(_Domain):
    async def list_operations(self) -> list[OperationDescriptor]:
        raise RuntimeError("domain unavailable (test)")


class _Recorder:
    def __init__(self, *, fail: bool = False) -> None:
        self.denied_calls: list[dict[str, Any]] = []
        self._fail = fail

    async def invoked(self, **kwargs: Any) -> None: ...

    async def denied(self, **kwargs: Any) -> None:
        self.denied_calls.append(kwargs)
        if self._fail:
            raise RuntimeError("audit store down (test)")

    async def approval_requested(self, **kwargs: Any) -> None: ...

    async def approved(self, **kwargs: Any) -> None: ...


def _resolve(harness: Harness, ref: str) -> Any:
    token = harness.issue([Scope(kind="read", ref=ref)])
    return harness.client.get(
        f"{PREFIX}/binding/resolve?ref={quote(ref, safe='')}",
        headers={"authorization": f"Bearer {token}"},
    )


class TestGatedOperationsAreNotReadable:
    @pytest.mark.parametrize("tier", ["approve", "confirm"])
    def test_a_ref_naming_a_gated_operation_is_403_and_domain_invoke_is_not_called(
        self, tmp_path: Path, tier: str
    ) -> None:
        domain = _Domain(OperationDescriptor(name="purge", description="d", tier=tier))  # type: ignore[arg-type]
        harness = build_harness(tmp_path, domain=domain)
        res = _resolve(harness, "query://sales/purge?fy=2026")
        assert res.status_code == 403
        body = res.json()
        assert body["error"]["code"] == "CAPABILITY_DENIED"
        assert body["error"]["message"] == "gated operation is not readable"
        assert domain.invoke_calls == []

    def test_records_action_denied_with_the_descriptor_tier_and_the_fixed_reason(
        self, tmp_path: Path
    ) -> None:
        domain = _Domain(OperationDescriptor(name="purge", description="d", tier="approve"))
        recorder = _Recorder()
        harness = build_harness(tmp_path, domain=domain, action_audit_recorder=recorder)
        res = _resolve(harness, "query://sales/purge?fy=2026")
        assert res.status_code == 403
        assert len(recorder.denied_calls) == 1
        call = recorder.denied_calls[0]
        assert call["action"] == "purge"
        assert call["tier"] == "approve"
        assert call["reason"] == "gated operation is not readable"
        assert call["principal"].id == "tester"
        assert domain.invoke_calls == []

    def test_a_throwing_recorder_does_not_turn_the_denial_into_a_failure(
        self, tmp_path: Path
    ) -> None:
        domain = _Domain(OperationDescriptor(name="purge", description="d", tier="confirm"))
        recorder = _Recorder(fail=True)
        seen: list[str] = []
        harness = build_harness(
            tmp_path,
            domain=domain,
            action_audit_recorder=recorder,
            on_error=lambda info: seen.append(info.endpoint),
        )
        res = _resolve(harness, "query://sales/purge")
        assert res.status_code == 403
        assert len(recorder.denied_calls) == 1
        assert seen == ["binding/resolve.audit"]
        assert domain.invoke_calls == []

    def test_a_tier_less_operation_and_a_tier_auto_operation_stay_readable(
        self, tmp_path: Path
    ) -> None:
        domain = _Domain(
            OperationDescriptor(name="records", description="d"),
            OperationDescriptor(name="trend", description="d", tier="auto"),
        )
        harness = build_harness(tmp_path, domain=domain)
        assert _resolve(harness, "query://sales/records?fy=2026").status_code == 200
        assert _resolve(harness, "query://sales/trend").status_code == 200
        assert domain.invoke_calls == ["records", "trend"]

    def test_an_operation_absent_from_the_index_stays_readable(self, tmp_path: Path) -> None:
        domain = _Domain()
        harness = build_harness(tmp_path, domain=domain)
        assert _resolve(harness, "query://sales/records").status_code == 200
        assert domain.invoke_calls == ["records"]

    def test_an_operation_with_an_invalid_params_schema_is_still_gated_by_its_tier(
        self, tmp_path: Path
    ) -> None:
        domain = _Domain(
            OperationDescriptor(
                name="purge",
                description="d",
                tier="approve",
                paramsSchema={"type": "object", "$ref": "#/nope"},
            )
        )
        harness = build_harness(tmp_path, domain=domain)
        assert _resolve(harness, "query://sales/purge").status_code == 403
        assert domain.invoke_calls == []

    def test_an_unreadable_operation_index_fails_closed_with_503(self, tmp_path: Path) -> None:
        domain = _BrokenIndexDomain()
        recorder = _Recorder()
        seen: list[str] = []
        harness = build_harness(
            tmp_path,
            domain=domain,
            action_audit_recorder=recorder,
            on_error=lambda info: seen.append(info.endpoint),
        )
        res = _resolve(harness, "query://sales/records")
        assert res.status_code == 503
        body = res.json()
        assert body["error"]["code"] == "INTERNAL"
        assert body["error"]["message"] == "action gate unavailable"
        assert domain.invoke_calls == []
        assert len(recorder.denied_calls) == 1
        assert recorder.denied_calls[0]["action"] == "records"
        assert recorder.denied_calls[0]["tier"] == "auto"
        assert recorder.denied_calls[0]["reason"] == "action gate unavailable"
        assert "binding/resolve" in seen

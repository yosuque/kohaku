"""Tests for is_gated_operation / run_gated_read_guard (port of packages/host-core/test/gated-read.test.ts)."""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.host_core import (
    GATED_READ_MESSAGE,
    ActionAuditContext,
    OperationIndexEntry,
    create_gated_read_guard,
    create_operation_index,
    gated_tier,
    is_gated_operation,
    run_gated_read_guard,
)
from kohaku.spec import (
    InvocationContext,
    JsonObject,
    OperationDescriptor,
    Principal,
    action_payload_hash,
)

_PRINCIPAL = Principal(id="u1", roles=["user"])


class _Domain:
    def __init__(self, *ops: OperationDescriptor) -> None:
        self._ops = list(ops)

    async def list_operations(self) -> list[OperationDescriptor]:
        return self._ops

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        return {}


class _Recorder:
    def __init__(self, *, fail: BaseException | None = None) -> None:
        self.denied_calls: list[dict[str, Any]] = []
        self._fail = fail

    async def invoked(self, **kwargs: Any) -> None: ...

    async def denied(self, **kwargs: Any) -> None:
        self.denied_calls.append(kwargs)
        if self._fail is not None:
            raise self._fail

    async def approval_requested(self, **kwargs: Any) -> None: ...

    async def approved(self, **kwargs: Any) -> None: ...


def _entry(**kw: Any) -> OperationIndexEntry:
    return OperationIndexEntry(descriptor=OperationDescriptor(name="a", description="d", **kw))


def test_is_gated_operation_is_true_only_for_tier_confirm_and_approve() -> None:
    assert is_gated_operation(_entry(tier="approve")) is True
    assert is_gated_operation(_entry(tier="confirm")) is True
    assert is_gated_operation(_entry(tier="auto")) is False
    assert is_gated_operation(_entry()) is False


def _run(
    index: Any,
    action: str,
    recorder: _Recorder,
    *,
    reported_index: list[BaseException] | None = None,
    reported_audit: list[BaseException] | None = None,
    reported_schema: list[BaseException] | None = None,
) -> Any:
    async def report_audit(e: BaseException) -> None:
        if reported_audit is not None:
            reported_audit.append(e)

    async def report_index(e: BaseException) -> None:
        if reported_index is not None:
            reported_index.append(e)

    async def report_schema(e: BaseException) -> None:
        if reported_schema is not None:
            reported_schema.append(e)

    return asyncio.run(
        run_gated_read_guard(
            operation_index=index,
            operation=action,
            audit=ActionAuditContext(
                recorder=recorder,
                action=action,
                payload={"fy": "2026"},
                principal=_PRINCIPAL,
                tenant="t1",
                correlation_id="req-1",
                report=report_audit,
            ),
            report_index_failure=report_index,
            report_schema_error=report_schema,
        )
    )


def test_a_gated_operation_is_audited_as_action_denied_with_the_fixed_reason() -> None:
    recorder = _Recorder()
    index = create_operation_index(
        _Domain(OperationDescriptor(name="purge", description="d", tier="approve"))
    )
    outcome = _run(index, "purge", recorder)
    assert outcome.kind == "gated"
    assert outcome.tier == "approve"
    assert recorder.denied_calls == [
        {
            "action": "purge",
            "payload_hash": action_payload_hash({"fy": "2026"}),
            "tier": "approve",
            "reason": GATED_READ_MESSAGE,
            "principal": _PRINCIPAL,
            "tenant": "t1",
            "correlation_id": "req-1",
        }
    ]


def test_tier_less_tier_auto_and_unlisted_operations_are_readable_and_not_audited() -> None:
    recorder = _Recorder()
    index = create_operation_index(
        _Domain(
            OperationDescriptor(name="records", description="d"),
            OperationDescriptor(name="trend", description="d", tier="auto"),
        )
    )
    for action in ("records", "trend", "unlisted"):
        assert _run(index, action, recorder).kind == "readable"
    assert recorder.denied_calls == []


def test_a_throwing_recorder_is_reported_and_does_not_change_the_outcome() -> None:
    boom = RuntimeError("audit down (test)")
    recorder = _Recorder(fail=boom)
    reported: list[BaseException] = []
    index = create_operation_index(
        _Domain(OperationDescriptor(name="purge", description="d", tier="confirm"))
    )
    outcome = _run(index, "purge", recorder, reported_audit=reported)
    assert outcome.kind == "gated"
    assert outcome.tier == "confirm"
    assert reported == [boom]


def test_an_unreadable_index_is_reported_and_audited_as_action_denied_tier_auto() -> None:
    boom = RuntimeError("list failed (test)")
    recorder = _Recorder()
    reported: list[BaseException] = []

    async def broken() -> dict[str, OperationIndexEntry]:
        raise boom

    outcome = _run(broken, "records", recorder, reported_index=reported)
    assert outcome.kind == "indexUnavailable"
    assert reported == [boom]
    assert len(recorder.denied_calls) == 1
    assert recorder.denied_calls[0]["action"] == "records"
    assert recorder.denied_calls[0]["tier"] == "auto"
    assert recorder.denied_calls[0]["reason"] == "action gate unavailable"


def test_a_recorder_less_audit_context_is_a_no_op() -> None:
    async def report(e: BaseException) -> None: ...

    index = create_operation_index(
        _Domain(OperationDescriptor(name="purge", description="d", tier="approve"))
    )
    outcome = asyncio.run(
        run_gated_read_guard(
            operation_index=index,
            operation="purge",
            audit=ActionAuditContext(
                recorder=None,
                action="purge",
                payload={},
                principal=_PRINCIPAL,
                correlation_id="req-1",
                report=report,
            ),
            report_index_failure=report,
            report_schema_error=report,
        )
    )
    assert outcome.kind == "gated"


def test_a_tier_less_operation_with_an_invalid_params_schema_is_schema_invalid_reported_once() -> (
    None
):
    recorder = _Recorder()
    reported: list[BaseException] = []
    index = create_operation_index(
        _Domain(
            OperationDescriptor(
                name="odd", description="d", paramsSchema={"type": "object", "$ref": "#/nope"}
            )
        )
    )
    outcome = _run(index, "odd", recorder, reported_schema=reported)
    assert outcome.kind == "schemaInvalid"
    assert len(reported) == 1
    assert recorder.denied_calls == []


def test_a_gated_operation_with_an_invalid_params_schema_is_refused_as_gated() -> None:
    recorder = _Recorder()
    index = create_operation_index(
        _Domain(
            OperationDescriptor(
                name="purge",
                description="d",
                tier="approve",
                paramsSchema={"type": "object", "$ref": "#/nope"},
            )
        )
    )
    outcome = _run(index, "purge", recorder)
    assert outcome.kind == "gated"
    assert len(recorder.denied_calls) == 1


def test_gated_tier_narrows_the_declared_tier() -> None:
    assert gated_tier(_entry(tier="approve")) == "approve"
    assert gated_tier(_entry(tier="confirm")) == "confirm"
    assert gated_tier(_entry(tier="auto")) is None
    assert gated_tier(_entry()) is None


def test_one_guard_reads_a_rejected_index_reports_and_audits_once() -> None:
    class _CountingBrokenDomain(_Domain):
        calls = 0

        async def list_operations(self) -> list[OperationDescriptor]:
            _CountingBrokenDomain.calls += 1
            raise RuntimeError("list failed (test)")

    domain = _CountingBrokenDomain()
    recorder = _Recorder()
    reported_index: list[BaseException] = []

    async def report_index(e: BaseException) -> None:
        reported_index.append(e)

    async def noop(e: BaseException) -> None: ...

    guard = create_gated_read_guard(
        operation_index=create_operation_index(domain),
        report_index_failure=report_index,
        report_schema_error=noop,
    )

    async def run() -> list[Any]:
        audit = ActionAuditContext(
            recorder=recorder,
            action="ignored",
            payload={},
            principal=_PRINCIPAL,
            correlation_id="req-1",
            report=noop,
        )
        return list(await asyncio.gather(*(guard(op, audit) for op in ("a", "b", "c", "d"))))

    outcomes = asyncio.run(run())
    assert all(o.kind == "indexUnavailable" for o in outcomes)
    assert _CountingBrokenDomain.calls == 1
    assert len(reported_index) == 1
    assert len(recorder.denied_calls) == 1


def test_the_operation_name_is_passed_explicitly_audit_action_is_overwritten() -> None:
    recorder = _Recorder()
    index = create_operation_index(
        _Domain(OperationDescriptor(name="purge", description="d", tier="confirm"))
    )

    async def noop(e: BaseException) -> None: ...

    guard = create_gated_read_guard(
        operation_index=index, report_index_failure=noop, report_schema_error=noop
    )
    audit = ActionAuditContext(
        recorder=recorder,
        action="ignored",
        payload={},
        principal=_PRINCIPAL,
        correlation_id="req-1",
        report=noop,
    )

    async def run() -> Any:
        return await guard("purge", audit)

    outcome = asyncio.run(run())
    assert outcome.kind == "gated"
    assert recorder.denied_calls[0]["action"] == "purge"
    assert recorder.denied_calls[0]["tier"] == "confirm"

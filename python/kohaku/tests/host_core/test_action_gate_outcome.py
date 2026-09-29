"""Tests for record_action_gate_result / record_undeclared_action_denial (port of
packages/host-core/test/action-gate-outcome.test.ts)."""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.host_core import (
    ACTION_GATE_UNAVAILABLE_MESSAGE,
    APPROVAL_TOKEN_REJECTED_MESSAGE,
    APPROVAL_TOKEN_REQUIRED_MESSAGE,
    CONFIRMATION_REQUIRED_MESSAGE,
    NO_APPROVAL_PORT_REASON,
    UNDECLARED_ACTION_MESSAGE,
    ActionAuditContext,
    ActionGateAllow,
    ActionGateApprovalRequired,
    ActionGateDenied,
    ActionGateInvalid,
    record_action_gate_result,
    record_action_gate_unavailable_denial,
    record_undeclared_action_denial,
)
from kohaku.spec import ActionParamIssue, ApprovalGrant, ApprovalRequiredInfo, Principal

PRINCIPAL = Principal(id="u1")
HASH = "sha256:" + "a" * 64


class _Recorder:
    def __init__(self, *, fail_denied: bool = False, fail_invoked: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._fail_denied = fail_denied
        self._fail_invoked = fail_invoked

    async def invoked(self, **kwargs: Any) -> None:
        if self._fail_invoked:
            raise RuntimeError("sink down")
        self.calls.append(("invoked", kwargs))

    async def denied(self, **kwargs: Any) -> None:
        if self._fail_denied:
            raise RuntimeError("sink down")
        self.calls.append(("denied", kwargs))

    async def approval_requested(self, **kwargs: Any) -> None:
        self.calls.append(("approval_requested", kwargs))

    async def approved(self, **kwargs: Any) -> None:
        self.calls.append(("approved", kwargs))


def _ctx(recorder: Any, reported: list[BaseException] | None = None, tenant: str | None = None) -> ActionAuditContext:
    sink = reported if reported is not None else []

    async def report(exc: BaseException) -> None:
        sink.append(exc)

    return ActionAuditContext(
        recorder=recorder,
        action="annotate",
        payload={"note": "hi"},
        principal=PRINCIPAL,
        correlation_id="req-1",
        tenant=tenant,
        report=report,
    )


def test_invalid_records_nothing_and_returns_the_issues() -> None:
    recorder = _Recorder()
    issues = [ActionParamIssue(path="note", code="maxLength", message="expected at most 5 characters")]
    outcome = asyncio.run(record_action_gate_result(ActionGateInvalid(issues=issues), _ctx(recorder)))
    assert outcome.kind == "invalid"
    assert outcome.issues == issues
    assert recorder.calls == []


def test_approval_required_confirm_records_and_returns_the_confirmation_message() -> None:
    recorder = _Recorder()
    gate = ActionGateApprovalRequired(tier="confirm", payloadHash=HASH, requestId="r1")
    outcome = asyncio.run(record_action_gate_result(gate, _ctx(recorder, tenant="t1")))
    assert outcome.kind == "approvalRequired"
    assert outcome.message == CONFIRMATION_REQUIRED_MESSAGE
    assert outcome.approval == ApprovalRequiredInfo(
        requestId="r1", action="annotate", tier="confirm", payloadHash=HASH
    )
    assert recorder.calls == [
        (
            "approval_requested",
            {
                "action": "annotate",
                "payload_hash": HASH,
                "tier": "confirm",
                "request_id": "r1",
                "payload": {"note": "hi"},
                "principal": PRINCIPAL,
                "tenant": "t1",
                "correlation_id": "req-1",
            },
        )
    ]


def test_approval_required_approve_uses_the_approval_token_message() -> None:
    gate = ActionGateApprovalRequired(tier="approve", payloadHash=HASH, requestId="r2")
    outcome = asyncio.run(record_action_gate_result(gate, _ctx(_Recorder())))
    assert outcome.kind == "approvalRequired"
    assert outcome.message == APPROVAL_TOKEN_REQUIRED_MESSAGE


def test_denied_records_the_detailed_reason_but_returns_a_fixed_client_message() -> None:
    recorder = _Recorder()
    reason = "approval is bound to a different requester"
    gate = ActionGateDenied(payloadHash=HASH, requestId="r3", reason=reason)
    outcome = asyncio.run(record_action_gate_result(gate, _ctx(recorder)))
    assert outcome.kind == "approvalRequired"
    assert outcome.message == APPROVAL_TOKEN_REJECTED_MESSAGE
    assert outcome.approval.tier == "approve"
    assert [name for name, _ in recorder.calls] == ["denied"]
    assert recorder.calls[0][1]["reason"] == reason


def test_denied_by_a_host_with_no_approval_port_keeps_its_fixed_diagnosis() -> None:
    gate = ActionGateDenied(payloadHash=HASH, requestId="r5", reason=NO_APPROVAL_PORT_REASON)
    outcome = asyncio.run(record_action_gate_result(gate, _ctx(_Recorder())))
    assert outcome.kind == "approvalRequired"
    assert outcome.message == NO_APPROVAL_PORT_REASON


def test_allow_records_invoked_and_approved_when_a_grant_was_consumed() -> None:
    recorder = _Recorder()
    grant = ApprovalGrant(
        action="annotate", payloadHash=HASH, approverId="boss", requesterId="u1", exp=4102444800, jti="j1"
    )
    outcome = asyncio.run(
        record_action_gate_result(
            ActionGateAllow(tier="approve", payloadHash=HASH, grant=grant), _ctx(recorder)
        )
    )
    assert outcome.kind == "proceed"
    assert [name for name, _ in recorder.calls] == ["invoked", "approved"]


def test_allow_without_a_grant_records_only_invoked() -> None:
    recorder = _Recorder()
    outcome = asyncio.run(
        record_action_gate_result(ActionGateAllow(tier="auto", payloadHash=HASH), _ctx(recorder))
    )
    assert outcome.kind == "proceed"
    assert [name for name, _ in recorder.calls] == ["invoked"]


def test_recording_is_fail_open() -> None:
    reported: list[BaseException] = []
    gate = ActionGateDenied(payloadHash=HASH, requestId="r4", reason="nope")
    outcome = asyncio.run(
        record_action_gate_result(gate, _ctx(_Recorder(fail_denied=True), reported))
    )
    assert outcome.kind == "approvalRequired"
    assert len(reported) == 1


def test_a_failing_invoked_write_does_not_drop_the_approved_record() -> None:
    reported: list[BaseException] = []
    recorder = _Recorder(fail_invoked=True)
    grant = ApprovalGrant(
        action="annotate", payloadHash=HASH, approverId="boss", requesterId="u1", exp=4102444800, jti="j1"
    )
    outcome = asyncio.run(
        record_action_gate_result(
            ActionGateAllow(tier="approve", payloadHash=HASH, grant=grant), _ctx(recorder, reported)
        )
    )
    assert outcome.kind == "proceed"
    assert [name for name, _ in recorder.calls] == ["approved"]
    assert len(reported) == 1


def test_with_no_recorder_the_outcome_is_still_returned() -> None:
    outcome = asyncio.run(
        record_action_gate_result(ActionGateAllow(tier="auto", payloadHash=HASH), _ctx(None))
    )
    assert outcome.kind == "proceed"


def test_undeclared_denial_records_action_denied_with_tier_auto() -> None:
    recorder = _Recorder()
    asyncio.run(record_undeclared_action_denial(_ctx(recorder, tenant="t1")))
    assert len(recorder.calls) == 1
    name, kwargs = recorder.calls[0]
    assert name == "denied"
    assert kwargs["tier"] == "auto"
    assert kwargs["reason"] == UNDECLARED_ACTION_MESSAGE
    assert kwargs["payload_hash"].startswith("sha256:")
    assert kwargs["tenant"] == "t1"
    assert kwargs["correlation_id"] == "req-1"


def test_undeclared_denial_is_fail_open() -> None:
    reported: list[BaseException] = []
    asyncio.run(record_undeclared_action_denial(_ctx(_Recorder(fail_denied=True), reported)))
    assert len(reported) == 1


def test_unavailable_denial_records_action_denied_with_the_fixed_reason_and_defaults_to_tier_auto() -> None:
    recorder = _Recorder()
    asyncio.run(record_action_gate_unavailable_denial(_ctx(recorder, tenant="t1")))
    assert len(recorder.calls) == 1
    name, kwargs = recorder.calls[0]
    assert name == "denied"
    assert kwargs["tier"] == "auto"
    assert kwargs["reason"] == ACTION_GATE_UNAVAILABLE_MESSAGE
    assert kwargs["tenant"] == "t1"


def test_unavailable_denial_carries_the_descriptor_tier_and_is_fail_open() -> None:
    reported: list[BaseException] = []
    recorder = _Recorder(fail_denied=True)
    asyncio.run(record_action_gate_unavailable_denial(_ctx(recorder, reported), tier="approve"))
    assert len(reported) == 1

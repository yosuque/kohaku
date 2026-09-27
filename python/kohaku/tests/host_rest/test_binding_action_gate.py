"""Tests for the ActionGate wiring in POST /binding/action (port of
packages/host-rest/test/binding-action-gate.test.ts).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from kohaku.spec import (
    ApprovalGrant,
    ApprovalVerifyResult,
    InvocationContext,
    JsonObject,
    OperationDescriptor,
    Scope,
)

from .conftest import PREFIX, build_harness

NOTE_SCHEMA = {"type": "object", "properties": {"note": {"type": "string", "maxLength": 5}}, "required": ["note"]}


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


class _EchoDomain:
    def __init__(self, *ops: OperationDescriptor) -> None:
        self._ops = list(ops)
        self.invoke_calls: list[tuple[str, JsonObject]] = []

    async def list_operations(self) -> list[OperationDescriptor]:
        return self._ops

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        self.invoke_calls.append((op, args))
        return {"ok": True, "op": op, "args": args}


class _RecordingAuditRecorder:
    def __init__(self) -> None:
        self.invoked_calls: list[dict[str, Any]] = []
        self.denied_calls: list[dict[str, Any]] = []
        self.approval_requested_calls: list[dict[str, Any]] = []
        self.approved_calls: list[dict[str, Any]] = []

    async def invoked(self, **kwargs: Any) -> None:
        self.invoked_calls.append(kwargs)

    async def denied(self, **kwargs: Any) -> None:
        self.denied_calls.append(kwargs)

    async def approval_requested(self, **kwargs: Any) -> None:
        self.approval_requested_calls.append(kwargs)

    async def approved(self, **kwargs: Any) -> None:
        self.approved_calls.append(kwargs)


class _FailingApprovalRequestedRecorder(_RecordingAuditRecorder):
    async def approval_requested(self, **kwargs: Any) -> None:
        raise RuntimeError("recorder unavailable (test)")


def _post_action(harness: Any, body: dict[str, Any], token: str) -> Any:
    return harness.client.post(
        _url("/binding/action"), json=body, headers={"authorization": f"Bearer {token}"}
    )


class TestTierAuto:
    def test_absent_from_list_operations_is_invoked_ungated(self, tmp_path: Path) -> None:
        domain = _EchoDomain()
        harness = build_harness(tmp_path, domain=domain)
        token = harness.issue([Scope(kind="write", ref="annotate")])
        res = _post_action(harness, {"action": "annotate", "payload": {"note": "hi"}}, token)
        assert res.status_code == 200

    def test_present_with_tier_auto_is_invoked_once_params_validate(self, tmp_path: Path) -> None:
        domain = _EchoDomain(
            OperationDescriptor(name="annotate", description="d", paramsSchema=NOTE_SCHEMA)
        )
        harness = build_harness(tmp_path, domain=domain)
        token = harness.issue([Scope(kind="write", ref="annotate")])
        res = _post_action(harness, {"action": "annotate", "payload": {"note": "hi"}}, token)
        assert res.status_code == 200
        assert len(domain.invoke_calls) == 1


class TestParamsValidation:
    def test_rejects_invalid_params_with_422(self, tmp_path: Path) -> None:
        domain = _EchoDomain(
            OperationDescriptor(name="annotate", description="d", paramsSchema=NOTE_SCHEMA)
        )
        harness = build_harness(tmp_path, domain=domain)
        token = harness.issue([Scope(kind="write", ref="annotate")])
        res = _post_action(harness, {"action": "annotate", "payload": {"note": "way too long"}}, token)
        assert res.status_code == 422
        body = res.json()
        assert body["error"]["code"] == "ACTION_PARAMS_INVALID"
        assert body["error"]["issues"] == [
            {"path": "note", "code": "maxLength", "message": "expected at most 5 characters"}
        ]
        assert domain.invoke_calls == []


class TestTierConfirm:
    def test_without_confirmed_returns_403(self, tmp_path: Path) -> None:
        domain = _EchoDomain(OperationDescriptor(name="annotate", description="d", tier="confirm"))
        harness = build_harness(tmp_path, domain=domain)
        token = harness.issue([Scope(kind="write", ref="annotate")])
        res = _post_action(harness, {"action": "annotate", "payload": {}}, token)
        assert res.status_code == 403
        body = res.json()
        assert body["error"]["code"] == "APPROVAL_REQUIRED"
        assert body["error"]["approval"]["action"] == "annotate"
        assert body["error"]["approval"]["tier"] == "confirm"
        assert isinstance(body["error"]["approval"]["requestId"], str)
        assert domain.invoke_calls == []

    def test_with_confirmed_true_invokes_the_domain(self, tmp_path: Path) -> None:
        domain = _EchoDomain(OperationDescriptor(name="annotate", description="d", tier="confirm"))
        harness = build_harness(tmp_path, domain=domain)
        token = harness.issue([Scope(kind="write", ref="annotate")])
        res = _post_action(harness, {"action": "annotate", "payload": {}, "confirmed": True}, token)
        assert res.status_code == 200
        assert len(domain.invoke_calls) == 1

    def test_records_approval_requested_then_invoked(self, tmp_path: Path) -> None:
        domain = _EchoDomain(OperationDescriptor(name="annotate", description="d", tier="confirm"))
        recorder = _RecordingAuditRecorder()
        harness = build_harness(tmp_path, domain=domain, action_audit_recorder=recorder)
        token = harness.issue([Scope(kind="write", ref="annotate")])

        _post_action(harness, {"action": "annotate", "payload": {}}, token)
        assert len(recorder.approval_requested_calls) == 1
        assert recorder.approval_requested_calls[0]["action"] == "annotate"
        assert recorder.approval_requested_calls[0]["tier"] == "confirm"

        _post_action(harness, {"action": "annotate", "payload": {}, "confirmed": True}, token)
        assert len(recorder.invoked_calls) == 1
        assert recorder.invoked_calls[0]["action"] == "annotate"

    def test_a_throwing_recorder_does_not_break_the_response(self, tmp_path: Path) -> None:
        domain = _EchoDomain(OperationDescriptor(name="annotate", description="d", tier="confirm"))
        recorder = _FailingApprovalRequestedRecorder()
        seen: list[str] = []
        harness = build_harness(
            tmp_path,
            domain=domain,
            action_audit_recorder=recorder,
            on_error=lambda info: seen.append(info.endpoint),
        )
        token = harness.issue([Scope(kind="write", ref="annotate")])
        res = _post_action(harness, {"action": "annotate", "payload": {}}, token)
        assert res.status_code == 403
        assert seen == ["binding/action.audit"]


class _FakeApprovals:
    def __init__(self, verify_result: ApprovalVerifyResult) -> None:
        self.verify_result = verify_result
        self.verify_calls: list[dict[str, Any]] = []

    async def issue_approval(self, **kwargs: Any) -> str:
        raise AssertionError("not used in these tests")

    async def verify_approval(self, token: str, **kwargs: Any) -> ApprovalVerifyResult:
        self.verify_calls.append({"token": token, **kwargs})
        return self.verify_result


class TestTierApprove:
    def test_without_a_token_returns_403(self, tmp_path: Path) -> None:
        domain = _EchoDomain(OperationDescriptor(name="delete", description="d", tier="approve"))
        approvals = _FakeApprovals(ApprovalVerifyResult(ok=True))
        harness = build_harness(tmp_path, domain=domain, approvals=approvals)
        token = harness.issue([Scope(kind="write", ref="delete")])
        res = _post_action(harness, {"action": "delete", "payload": {}}, token)
        assert res.status_code == 403
        assert res.json()["error"]["approval"]["tier"] == "approve"

    def test_without_an_approval_port_configured_returns_403_denied(self, tmp_path: Path) -> None:
        domain = _EchoDomain(OperationDescriptor(name="delete", description="d", tier="approve"))
        harness = build_harness(tmp_path, domain=domain)
        token = harness.issue([Scope(kind="write", ref="delete")])
        res = _post_action(harness, {"action": "delete", "payload": {}, "approval": "some-token"}, token)
        assert res.status_code == 403

    def test_with_a_valid_token_invokes_the_domain_and_records_approved(self, tmp_path: Path) -> None:
        domain = _EchoDomain(OperationDescriptor(name="delete", description="d", tier="approve"))

        async def verify(_token: str, **kwargs: Any) -> ApprovalVerifyResult:
            return ApprovalVerifyResult(
                ok=True,
                grant=ApprovalGrant(
                    action="delete",
                    payloadHash=kwargs["payload_hash"],
                    approverId="approver-1",
                    requesterId="tester",
                    exp=9999999999,
                    jti="jti-1",
                ),
            )

        class _Approvals:
            async def issue_approval(self, **kwargs: Any) -> str:
                raise AssertionError("not used")

            async def verify_approval(self, token: str, **kwargs: Any) -> ApprovalVerifyResult:
                return await verify(token, **kwargs)

        recorder = _RecordingAuditRecorder()
        harness = build_harness(
            tmp_path, domain=domain, approvals=_Approvals(), action_audit_recorder=recorder
        )
        cap_token = harness.issue([Scope(kind="write", ref="delete")])
        res = _post_action(
            harness, {"action": "delete", "payload": {"id": 1}, "approval": "token-abc"}, cap_token
        )
        assert res.status_code == 200
        assert len(domain.invoke_calls) == 1
        assert len(recorder.approved_calls) == 1
        assert recorder.approved_calls[0]["grant"].approverId == "approver-1"

    def test_with_an_invalid_token_returns_403_and_records_denied_not_approval_requested(
        self, tmp_path: Path
    ) -> None:
        domain = _EchoDomain(OperationDescriptor(name="delete", description="d", tier="approve"))
        approvals = _FakeApprovals(ApprovalVerifyResult(ok=False, reason="approval already used"))
        recorder = _RecordingAuditRecorder()
        harness = build_harness(
            tmp_path, domain=domain, approvals=approvals, action_audit_recorder=recorder
        )
        token = harness.issue([Scope(kind="write", ref="delete")])
        res = _post_action(
            harness, {"action": "delete", "payload": {}, "approval": "token-abc"}, token
        )
        assert res.status_code == 403
        assert len(recorder.denied_calls) == 1
        assert recorder.denied_calls[0]["reason"] == "approval already used"
        assert recorder.approval_requested_calls == []
        assert domain.invoke_calls == []

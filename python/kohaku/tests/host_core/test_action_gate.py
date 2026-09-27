"""Tests for ActionGate / create_action_gate (port of packages/host-core/test/action-gate.test.ts)."""

from __future__ import annotations

import asyncio

from kohaku.host_core.action_gate import ActionGateRequest, create_action_gate
from kohaku.spec import (
    ActionParamsSchema,
    ApprovalGrant,
    ApprovalVerifyResult,
    OperationDescriptor,
    action_payload_hash,
)

AUTO = OperationDescriptor(name="publish", description="d")
CONFIRM = OperationDescriptor(name="annotate", description="d", tier="confirm")
APPROVE = OperationDescriptor(name="delete", description="d", tier="approve")

NOTE_SCHEMA: ActionParamsSchema = {
    "type": "object",
    "properties": {"note": {"type": "string", "maxLength": 5}},
    "required": ["note"],
}


class _FakeApprovals:
    def __init__(self, verdict: ApprovalVerifyResult) -> None:
        self._verdict = verdict
        self.calls: list[dict[str, object]] = []

    async def issue_approval(self, **kwargs: object) -> str:
        raise AssertionError("not used in these tests")

    async def verify_approval(
        self, token: str, *, action: str, payload_hash: str, requester_id: str, tenant: str | None = None
    ) -> ApprovalVerifyResult:
        self.calls.append(
            {"token": token, "action": action, "payload_hash": payload_hash, "requester_id": requester_id, "tenant": tenant}
        )
        return self._verdict


def test_invalid_params_short_circuits_before_tier_gating() -> None:
    gate = create_action_gate()

    async def run() -> None:
        result = await gate.check(
            ActionGateRequest(
                descriptor=CONFIRM,
                params_schema=NOTE_SCHEMA,
                payload={"note": "way too long"},
                requester_id="u1",
            )
        )
        assert result.kind == "invalid"
        assert [(i.path, i.code, i.message) for i in result.issues] == [
            ("note", "maxLength", "expected at most 5 characters")
        ]

    asyncio.run(run())


def test_skips_validation_when_no_params_schema_is_declared() -> None:
    gate = create_action_gate()

    async def run() -> None:
        result = await gate.check(ActionGateRequest(descriptor=AUTO, payload={"anything": 1}, requester_id="u1"))
        assert result.kind == "allow"

    asyncio.run(run())


def test_tier_auto_always_allows() -> None:
    gate = create_action_gate()

    async def run() -> None:
        result = await gate.check(ActionGateRequest(descriptor=AUTO, payload={}, requester_id="u1"))
        assert result.kind == "allow"
        assert result.tier == "auto"

    asyncio.run(run())


def test_tier_confirm_requires_confirmed_true() -> None:
    gate = create_action_gate()

    async def run() -> None:
        pending = await gate.check(
            ActionGateRequest(descriptor=CONFIRM, payload={"note": "hi"}, requester_id="u1")
        )
        assert pending.kind == "approvalRequired"
        assert pending.tier == "confirm"
        assert isinstance(pending.requestId, str) and pending.requestId

        allowed = await gate.check(
            ActionGateRequest(descriptor=CONFIRM, payload={"note": "hi"}, confirmed=True, requester_id="u1")
        )
        assert allowed.kind == "allow"
        assert allowed.tier == "confirm"

    asyncio.run(run())


def test_confirm_mints_a_fresh_request_id_each_check() -> None:
    gate = create_action_gate()

    async def run() -> None:
        a = await gate.check(ActionGateRequest(descriptor=CONFIRM, payload={}, requester_id="u1"))
        b = await gate.check(ActionGateRequest(descriptor=CONFIRM, payload={}, requester_id="u1"))
        assert a.kind == "approvalRequired" and b.kind == "approvalRequired"
        assert a.requestId != b.requestId

    asyncio.run(run())


def test_approve_without_a_token_is_approval_required() -> None:
    approvals = _FakeApprovals(ApprovalVerifyResult(ok=True))
    gate = create_action_gate(approvals)

    async def run() -> None:
        result = await gate.check(ActionGateRequest(descriptor=APPROVE, payload={}, requester_id="u1"))
        assert result.kind == "approvalRequired"
        assert result.tier == "approve"
        assert approvals.calls == []

    asyncio.run(run())


def test_approve_with_no_approval_port_configured_is_denied() -> None:
    gate = create_action_gate()

    async def run() -> None:
        result = await gate.check(
            ActionGateRequest(descriptor=APPROVE, payload={}, approval="some-token", requester_id="u1")
        )
        assert result.kind == "denied"

    asyncio.run(run())


def test_approve_allows_and_surfaces_the_grant_on_success() -> None:
    grant = ApprovalGrant(
        action="delete",
        payloadHash="sha256:x",
        approverId="approver-1",
        requesterId="u1",
        exp=9999999999,
        jti="jti-1",
    )
    approvals = _FakeApprovals(ApprovalVerifyResult(ok=True, grant=grant))
    gate = create_action_gate(approvals)

    async def run() -> None:
        result = await gate.check(
            ActionGateRequest(
                descriptor=APPROVE,
                payload={"id": 1},
                approval="token-abc",
                requester_id="u1",
                tenant="tenant-a",
            )
        )
        assert result.kind == "allow"
        assert result.grant is grant
        assert len(approvals.calls) == 1
        call = approvals.calls[0]
        assert call["token"] == "token-abc"
        assert call["action"] == "delete"
        assert call["requester_id"] == "u1"
        assert call["tenant"] == "tenant-a"
        assert call["payload_hash"] == action_payload_hash({"id": 1})

    asyncio.run(run())


def test_approve_denies_with_the_approval_ports_own_reason() -> None:
    approvals = _FakeApprovals(ApprovalVerifyResult(ok=False, reason="approval already used"))
    gate = create_action_gate(approvals)

    async def run() -> None:
        result = await gate.check(
            ActionGateRequest(descriptor=APPROVE, payload={}, approval="token-abc", requester_id="u1")
        )
        assert result.kind == "denied"
        assert result.reason == "approval already used"

    asyncio.run(run())


def test_payload_hash_matches_an_independently_computed_hash_for_every_outcome_kind() -> None:
    gate = create_action_gate()
    expected = action_payload_hash({"x": 1})

    async def run() -> None:
        allow = await gate.check(ActionGateRequest(descriptor=AUTO, payload={"x": 1}, requester_id="u1"))
        pending = await gate.check(ActionGateRequest(descriptor=CONFIRM, payload={"x": 1}, requester_id="u1"))
        assert allow.kind == "allow" and allow.payloadHash == expected
        assert pending.kind == "approvalRequired" and pending.payloadHash == expected

    asyncio.run(run())

"""Tests for POST /approvals (port of packages/host-rest/test/approvals.test.ts)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from kohaku.host_rest.deps import AuthorizeGovernanceHook

from .conftest import PREFIX, build_harness, role_auth

VALID_BODY = {"action": "delete", "payloadHash": "sha256:" + "a" * 64, "requesterId": "requester-1"}


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


class _RecordingApprovals:
    def __init__(self, token: str = "kohaku-approval.v1.token") -> None:
        self.token = token
        self.issue_calls: list[dict[str, Any]] = []

    async def issue_approval(self, **kwargs: Any) -> str:
        self.issue_calls.append(kwargs)
        return self.token

    async def verify_approval(self, token: str, **kwargs: Any) -> Any:
        raise AssertionError("not used in these tests")


class _ThrowingApprovals:
    async def issue_approval(self, **kwargs: Any) -> str:
        raise ValueError("cannot issue an approval: approverId must differ from requesterId")

    async def verify_approval(self, token: str, **kwargs: Any) -> Any:
        raise AssertionError("not used in these tests")


def test_returns_501_when_approvals_is_not_configured(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 501
    assert res.json()["error"]["code"] == "NOT_IMPLEMENTED"


def test_issues_a_token_when_authorized_and_approver_differs_from_requester(tmp_path: Path) -> None:
    approvals = _RecordingApprovals()
    harness = build_harness(tmp_path, approvals=approvals, auth=role_auth("approver"))
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 200
    assert res.json() == {"approval": "kohaku-approval.v1.token"}

    assert len(approvals.issue_calls) == 1
    call = approvals.issue_calls[0]
    assert call["action"] == "delete"
    assert call["payload_hash"] == VALID_BODY["payloadHash"]
    assert call["requester_id"] == "requester-1"
    assert call["approver_id"] == "demo-approver"


def test_rejects_a_self_approval_with_400(tmp_path: Path) -> None:
    approvals = _RecordingApprovals()

    def auth(_request: Any) -> Any:
        from kohaku.spec import Principal

        return Principal(id="requester-1", roles=["approver"])

    harness = build_harness(tmp_path, approvals=approvals, auth=auth)
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 400
    assert approvals.issue_calls == []


def test_returns_403_when_authorize_governance_denies_action_approve(tmp_path: Path) -> None:
    approvals = _RecordingApprovals()

    def deny_action_approve(_principal: Any, operation: Any, _tenant: Any) -> bool:
        return bool(operation.kind != "action.approve")

    authorize: AuthorizeGovernanceHook = deny_action_approve
    harness = build_harness(tmp_path, approvals=approvals, authorize_governance=authorize)
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "CAPABILITY_DENIED"


def test_rejects_a_missing_required_field_with_400(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, approvals=_RecordingApprovals())
    res = harness.client.post(_url("/approvals"), json={"action": "delete"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_a_raised_issue_approval_maps_to_400_with_its_message(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, approvals=_ThrowingApprovals(), auth=role_auth("approver"))
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 400
    assert "approverId must differ from requesterId" in res.json()["error"]["message"]


def test_passes_ttl_seconds_through_when_given(tmp_path: Path) -> None:
    approvals = _RecordingApprovals()
    harness = build_harness(tmp_path, approvals=approvals, auth=role_auth("approver"))
    res = harness.client.post(_url("/approvals"), json={**VALID_BODY, "ttlSeconds": 60})
    assert res.status_code == 200
    assert approvals.issue_calls[0]["ttl_seconds"] == 60

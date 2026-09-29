"""Tests for POST /approvals (port of packages/host-rest/test/approvals.test.ts)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from kohaku.host_rest.deps import AuthorizeGovernanceHook
from kohaku.spec import ApprovalIssueError

from .conftest import PREFIX, build_harness, role_auth


def _allow_all(_principal: Any, _operation: Any, _tenant: Any) -> bool:
    return True


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
    def __init__(self, error: BaseException) -> None:
        self._error = error

    async def issue_approval(self, **kwargs: Any) -> str:
        raise self._error

    async def verify_approval(self, token: str, **kwargs: Any) -> Any:
        raise AssertionError("not used in these tests")


def test_returns_501_when_approvals_is_not_configured(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 501
    assert res.json()["error"]["code"] == "NOT_IMPLEMENTED"


def test_fails_closed_with_501_when_approvals_is_wired_but_authorize_governance_is_not(
    tmp_path: Path,
) -> None:
    approvals = _RecordingApprovals()
    harness = build_harness(tmp_path, approvals=approvals, auth=role_auth("approver"))
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 501
    error = res.json()["error"]
    assert error["code"] == "NOT_IMPLEMENTED"
    assert "authorize_governance" in error["message"]
    assert approvals.issue_calls == []


def test_the_other_governance_routes_keep_allow_when_unwired(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    res = harness.client.post(_url("/telemetry"), json={"events": []})
    assert res.status_code == 200


def test_issues_a_token_when_authorized_and_approver_differs_from_requester(tmp_path: Path) -> None:
    approvals = _RecordingApprovals()
    harness = build_harness(
        tmp_path, approvals=approvals, auth=role_auth("approver"), authorize_governance=_allow_all
    )
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

    harness = build_harness(
        tmp_path, approvals=approvals, auth=auth, authorize_governance=_allow_all
    )
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
    harness = build_harness(
        tmp_path, approvals=_RecordingApprovals(), authorize_governance=_allow_all
    )
    res = harness.client.post(_url("/approvals"), json={"action": "delete"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_an_approval_issue_error_maps_to_400_with_its_message(tmp_path: Path) -> None:
    approvals = _ThrowingApprovals(
        ApprovalIssueError("cannot issue an approval: approverId must differ from requesterId")
    )
    harness = build_harness(
        tmp_path, approvals=approvals, auth=role_auth("approver"), authorize_governance=_allow_all
    )
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 400
    assert "approverId must differ from requesterId" in res.json()["error"]["message"]


def test_an_exception_carrying_the_client_caused_code_also_maps_to_400(tmp_path: Path) -> None:
    error = Exception("payload hash is not acceptable")
    error.code = "APPROVAL_ISSUE_REJECTED"  # type: ignore[attr-defined]
    harness = build_harness(
        tmp_path,
        approvals=_ThrowingApprovals(error),
        auth=role_auth("approver"),
        authorize_governance=_allow_all,
    )
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 400
    assert res.json()["error"]["message"] == "payload hash is not acceptable"


def test_any_other_raised_issue_approval_is_a_fixed_text_500_and_reaches_on_error(
    tmp_path: Path,
) -> None:
    boom = RuntimeError("connection to db-primary.internal:5432 refused")
    seen: list[Any] = []
    harness = build_harness(
        tmp_path,
        approvals=_ThrowingApprovals(boom),
        auth=role_auth("approver"),
        authorize_governance=_allow_all,
        on_error=lambda info: seen.append(info),
    )
    res = harness.client.post(_url("/approvals"), json=VALID_BODY)
    assert res.status_code == 500
    error = res.json()["error"]
    assert error["code"] == "INTERNAL"
    assert "db-primary" not in error["message"]
    assert len(seen) == 1
    assert seen[0].endpoint == "approvals"
    assert seen[0].error is boom
    assert seen[0].request_id == error["requestId"]


def test_passes_ttl_seconds_through_when_given(tmp_path: Path) -> None:
    approvals = _RecordingApprovals()
    harness = build_harness(
        tmp_path, approvals=approvals, auth=role_auth("approver"), authorize_governance=_allow_all
    )
    res = harness.client.post(_url("/approvals"), json={**VALID_BODY, "ttlSeconds": 60})
    assert res.status_code == 200
    assert approvals.issue_calls[0]["ttl_seconds"] == 60

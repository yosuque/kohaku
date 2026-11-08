"""A governed write whose answer never came back may or may not have been applied: POST /binding/action answers
503 INTERNAL with host_core's fixed OUTCOME_UNKNOWN_MESSAGE instead of the 404 every other failed write gets, and
the real error (which names the upstream tool) still reaches on_error. Port of the corresponding case in
packages/host-rest/test/binding-action.test.ts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from kohaku.spec import InvocationContext, JsonObject, OperationDescriptor, Scope

from .conftest import PREFIX, build_harness


class _FailingDomain:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def list_operations(self) -> list[OperationDescriptor]:
        return [OperationDescriptor(name="annotate", description="d")]

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        raise self._error


def _post(harness: Any) -> Any:
    token = harness.issue([Scope(kind="write", ref="annotate")])
    return harness.client.post(
        f"{PREFIX}/binding/action",
        json={"action": "annotate", "payload": {}},
        headers={"authorization": f"Bearer {token}"},
    )


def test_a_write_with_an_unknown_outcome_is_503_internal_with_the_fixed_message(
    tmp_path: Path,
) -> None:
    timed_out = RuntimeError('MCP tool "annotate": did not answer in time; its effect is unknown')
    timed_out.code = "MCP_OUTCOME_UNKNOWN"  # type: ignore[attr-defined]
    seen: list[Any] = []
    harness = build_harness(tmp_path, domain=_FailingDomain(timed_out), on_error=seen.append)
    res = _post(harness)
    assert res.status_code == 503
    body = res.json()["error"]
    assert body["code"] == "INTERNAL"
    assert body["message"] == "the action's outcome is unknown; verify before retrying"
    assert "did not answer" not in res.text
    assert [(i.endpoint, i.error) for i in seen] == [("binding/action", timed_out)]


def test_any_other_failed_write_stays_404_ref_not_found(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, domain=_FailingDomain(RuntimeError("write failed (test)")))
    res = _post(harness)
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "REF_NOT_FOUND"

"""domain_mcp behind the REST host (port of packages/domain-mcp/test/host.test.ts).

Two guarantees, both reached through `/binding/resolve` / `/binding/action` rather than the port alone:
an unsigned `_limit` can only lower the signed limit, and a write whose upstream call timed out is reported as
"outcome unknown" (503) instead of the 404 every failed read gets.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest

from kohaku.domain_mcp import create_mcp_domain_port
from kohaku.spec import Scope

from ..host_rest.conftest import PREFIX, Harness, build_harness
from ._fakes import LIST_ORDERS, REFUND_ORDER, FakeListResult, FakeResult, FakeTool

SIGNED_REF = "query://sales/list_orders?limit=1"
ROWS = [{"id": f"o-{n}", "total": n * 10, "placedAt": "2026-04-01"} for n in (1, 2, 3, 4)]


class Upstream:
    """An upstream whose `list_orders` does what a naive tool does with its `limit`: `rows[:limit]`, so a negative
    limit returns "all but the last rows" instead of lowering anything, which is what `_limit=-1` used to exploit.
    `refund_order` either answers, or (hang_write) performs the write and then never answers."""

    def __init__(self, *, hang_write: bool = False, hang_read: bool = False) -> None:
        self._hang_write = hang_write
        self._hang_read = hang_read
        self.limits: list[Any] = []
        self.writes = 0

    async def list_tools(self, *, cursor: str | None = None) -> FakeListResult:
        tools: list[FakeTool] = [LIST_ORDERS, REFUND_ORDER]
        return FakeListResult(tools=tools)

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: float | None = None,
    ) -> FakeResult:
        if name == "list_orders":
            limit = (arguments or {}).get("limit")
            self.limits.append(limit)
            if self._hang_read:
                await asyncio.Event().wait()
            return FakeResult(structured_content={"rows": ROWS[:limit]})
        self.writes += 1  # the effect happens ...
        if self._hang_write:
            await asyncio.Event().wait()  # ... but the answer is lost
        return FakeResult(structured_content={"refunded": True})


def _harness(
    tmp_path: Path, upstream: Upstream, call_timeout_ms: float = 30_000
) -> tuple[Harness, list[Any]]:
    port = asyncio.run(
        create_mcp_domain_port(
            client=upstream,
            call_timeout_ms=call_timeout_ms,
            # "auto" tier: this file is about the write's outcome, not the approval gate (test_e2e covers that).
            tier_for=lambda _tool: "auto",
        )
    )
    seen: list[Any] = []
    return build_harness(tmp_path, domain=port, on_error=seen.append), seen


def _resolve(harness: Harness, token: str, ref: str) -> Any:
    return harness.client.get(
        f"{PREFIX}/binding/resolve",
        params={"ref": ref},
        headers={"authorization": f"Bearer {token}"},
    )


@pytest.mark.parametrize("bad", ["-1", "0", "0.5", "-1e9", "abc"])
def test_refuses_a_non_positive_limit_on_a_ref_signed_with_limit_1(
    tmp_path: Path, bad: str
) -> None:
    upstream = Upstream()
    harness, _seen = _harness(tmp_path, upstream)
    token = harness.issue([Scope(kind="read", ref=SIGNED_REF)])
    res = _resolve(harness, token, f"{SIGNED_REF}&_limit={quote(bad)}")
    # The same 404 every failed read gets; the upstream was never asked for a widened range.
    assert res.status_code == 404
    assert upstream.limits == []


def test_returns_at_most_the_signed_row_and_still_honours_a_smaller_positive_limit(
    tmp_path: Path,
) -> None:
    upstream = Upstream()
    harness, _seen = _harness(tmp_path, upstream)
    token = harness.issue([Scope(kind="read", ref=SIGNED_REF)])
    for suffix in ("", "&_limit=3"):
        res = _resolve(harness, token, SIGNED_REF + suffix)
        assert res.status_code == 200
        assert len(res.json()["rows"]) == 1
    assert upstream.limits == [1, 1]


def test_a_write_whose_upstream_call_timed_out_is_503_with_the_fixed_message(
    tmp_path: Path,
) -> None:
    upstream = Upstream(hang_write=True)
    harness, seen = _harness(tmp_path, upstream, call_timeout_ms=20)
    token = harness.issue([Scope(kind="write", ref="refund_order")])
    res = harness.client.post(
        f"{PREFIX}/binding/action",
        json={"action": "refund_order", "payload": {"orderId": "o-1"}},
        headers={"authorization": f"Bearer {token}"},
    )
    assert res.status_code == 503
    body = res.json()["error"]
    assert body["code"] == "INTERNAL"
    assert body["message"] == "the action's outcome is unknown; verify before retrying"
    # The write did happen upstream (that is the whole point), and it was sent exactly once.
    assert upstream.writes == 1
    # The real error, with the tool name, went to on_error only.
    assert [i.endpoint for i in seen] == ["binding/action"]
    assert '"refund_order"' in str(seen[0].error)


def test_a_read_timeout_stays_the_ordinary_failed_read_404(tmp_path: Path) -> None:
    upstream = Upstream(hang_read=True)
    harness, _seen = _harness(tmp_path, upstream, call_timeout_ms=20)
    token = harness.issue([Scope(kind="read", ref=SIGNED_REF)])
    res = _resolve(harness, token, SIGNED_REF)
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "REF_NOT_FOUND"

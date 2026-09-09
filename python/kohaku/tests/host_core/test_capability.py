"""Tests for issue_capability_for_spec's allowed_actions write-scope filtering (port of
packages/host-core/test/capability.test.ts).
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.host_core import WriteScopeDroppedError, issue_capability_for_spec
from kohaku.spec import (
    IntentInput,
    Principal,
    Scope,
    UISpec,
    VerifyRequest,
    VerifyResult,
    finalize_intent,
)

PRINCIPAL = Principal(id="u1", roles=["user"])


def _spec_with_ref_and_action() -> UISpec:
    intent = finalize_intent(IntentInput(canonical="sales.trend", params={}))
    data: dict[str, Any] = {
        "kohaku": "0.1",
        "intent": intent.to_wire(),
        "dataVersion": "v1",
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["table"]},
            {
                "id": "table",
                "type": "presentTable",
                "props": {},
                "data": {"$ref": "query://sales/summary?fy=2026"},
            },
        ],
        "events": [{"on": "root.submit", "emit": "action.invoke", "payload": {"action": "sales.updateTarget"}}],
        "provenance": {"tier": "L0", "composedBy": "fixture", "cache": "miss"},
    }
    return UISpec.model_validate(data)


class FakeAuthz:
    """Records the scopes passed to issue_capability."""

    def __init__(self) -> None:
        self.calls: list[list[Scope]] = []

    async def issue_capability(
        self, principal: Principal, scopes: list[Scope], *, ttl_seconds: int | None = None
    ) -> str:
        self.calls.append(list(scopes))
        return "cap-token"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=True, principal=PRINCIPAL)


def test_drops_unlisted_write_scopes_and_reports() -> None:
    authz = FakeAuthz()
    dropped: list[str] = []

    async def run() -> str:
        return await issue_capability_for_spec(
            authz,
            PRINCIPAL,
            _spec_with_ref_and_action(),
            allowed_actions=frozenset(),
            on_dropped_action=dropped.append,
        )

    token = asyncio.run(run())
    assert token == "cap-token"
    scopes = authz.calls[0]
    assert Scope(kind="read", ref="query://sales/summary?fy=2026") in scopes
    assert Scope(kind="write", ref="sales.updateTarget") not in scopes
    assert dropped == ["sales.updateTarget"]


def test_no_filter_when_allowed_actions_none() -> None:
    authz = FakeAuthz()

    async def run() -> str:
        return await issue_capability_for_spec(authz, PRINCIPAL, _spec_with_ref_and_action())

    asyncio.run(run())
    scopes = authz.calls[0]
    assert Scope(kind="write", ref="sales.updateTarget") in scopes


def test_never_drops_read_scopes_even_with_empty_allowed_actions() -> None:
    authz = FakeAuthz()

    async def run() -> str:
        return await issue_capability_for_spec(
            authz, PRINCIPAL, _spec_with_ref_and_action(), allowed_actions=frozenset()
        )

    asyncio.run(run())
    scopes = authz.calls[0]
    assert Scope(kind="read", ref="query://sales/summary?fy=2026") in scopes


def test_write_scope_dropped_error_carries_the_action_name() -> None:
    err = WriteScopeDroppedError("sales.updateTarget")
    assert err.action == "sales.updateTarget"
    assert "sales.updateTarget" in str(err)

"""Tests for issue_capability_for_spec's allowed_actions write-scope filtering (port of
packages/host-core/test/capability.test.ts).
"""

from __future__ import annotations

import asyncio
import json
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
        "events": [
            {
                "on": "root.submit",
                "emit": "action.invoke",
                "payload": {"action": "sales.updateTarget"},
            }
        ],
        "provenance": {"tier": "L0", "composedBy": "fixture", "cache": "miss"},
    }
    return UISpec.model_validate(data)


class FakeAuthz:
    """Records the scopes passed to issue_capability."""

    def __init__(self) -> None:
        self.calls: list[list[Scope]] = []

    async def issue_capability(
        self,
        principal: Principal,
        scopes: list[Scope],
        *,
        ttl_seconds: int | None = None,
        tenant: str | None = None,
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


class TenantEchoAuthz:
    """An AuthzPort whose token is the JSON of what was issued, so verify echoes the issued tenant back."""

    def __init__(self) -> None:
        self.kwargs: list[dict[str, Any]] = []

    async def issue_capability(
        self,
        principal: Principal,
        scopes: list[Scope],
        *,
        ttl_seconds: int | None = None,
        tenant: str | None = None,
    ) -> str:
        self.kwargs.append({"ttl_seconds": ttl_seconds, "tenant": tenant})
        return json.dumps(
            {
                "sub": principal.id,
                "scopes": [{"kind": s.kind, "ref": s.ref} for s in scopes],
                "tenant": tenant,
            }
        )

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        claims = json.loads(token)
        granted = any(s["kind"] == req.kind and s["ref"] == req.ref for s in claims["scopes"])
        if not granted:
            return VerifyResult(ok=False, reason="scope does not cover request")
        return VerifyResult(ok=True, principal=Principal(id=claims["sub"]), tenant=claims["tenant"])


def test_tenant_is_bound_into_the_capability_and_reported_by_verify() -> None:
    """Port of capability.test.ts "capability tenant binding": a tenant passed to issuance shows up in verify."""
    authz = TenantEchoAuthz()

    async def run() -> VerifyResult:
        token = await issue_capability_for_spec(
            authz, PRINCIPAL, _spec_with_ref_and_action(), tenant="acme"
        )
        return await authz.verify(
            token, VerifyRequest(kind="read", ref="query://sales/summary?fy=2026")
        )

    result = asyncio.run(run())
    assert result.ok is True
    assert result.tenant == "acme"


class LegacyAuthz:
    """A port written before the `tenant` option existed: its issue_capability has no `tenant` keyword."""

    async def issue_capability(
        self, principal: Principal, scopes: list[Scope], *, ttl_seconds: int | None = None
    ) -> str:
        return "legacy-token"

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult:
        return VerifyResult(ok=True, principal=PRINCIPAL)


def test_tenant_keyword_is_omitted_entirely_when_there_is_none() -> None:
    """Without a tenant the call shape is exactly the pre-option one, so a legacy port keeps working
    (the type ignore is the point: such a port no longer satisfies the Protocol, but still runs)."""

    async def run() -> str:
        return await issue_capability_for_spec(
            LegacyAuthz(),  # type: ignore[arg-type]
            PRINCIPAL,
            _spec_with_ref_and_action(),
        )

    assert asyncio.run(run()) == "legacy-token"

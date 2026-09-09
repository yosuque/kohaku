"""Additional REST route behavior checks (paths not covered by conformance).

binding/action, telemetry, analytics, governance authorization, promotion lifecycle, fixation short-circuit, error correlation ID, etc.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_core import WriteScopeDroppedError
from kohaku.host_rest import (
    ActionEffects,
    GovernanceOperation,
    GovernancePolicy,
    HostErrorInfo,
    KohakuHostDeps,
    attach_kohaku_routes,
    create_governance_policy,
)
from kohaku.lineage import create_fixations, create_lineage, now_iso
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    CacheKeyParts,
    ComponentNode,
    IntentInput,
    InvocationContext,
    JsonObject,
    LineageActor,
    LineageEventRecord,
    OperationDescriptor,
    Principal,
    Provenance,
    Scope,
    UISpec,
    cache_key,
    finalize_intent,
)
from kohaku.storage import FileStoragePort

from .conftest import (
    INTENT_BODY,
    PREFIX,
    REF,
    FakeAuthz,
    FakeDomain,
    FakeSemantic,
    Harness,
    build_harness,
    role_auth,
)


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def _seed_generated(harness: Harness, artifact_id: str, *, with_preview: bool = False) -> None:
    payload: dict[str, Any] = {
        "artifactId": artifact_id,
        "canonical": "sales.custom",
        "request": "Custom sales view",
        "ref": harness.ref,
    }
    if with_preview:
        payload["html"] = "<!DOCTYPE html><html><body>art</body></html>"
        payload["artifactSha256"] = "sha256:" + "0" * 64
    asyncio.run(
        harness.storage.append_lineage(
            LineageEventRecord(
                id=f"gen-{artifact_id}",
                ts=now_iso(),
                actor=LineageActor(kind="model", model="fake"),
                type="component.generated",
                payload=payload,
            )
        )
    )


_DRAFT = {
    "componentType": "sales.customView",
    "version": "1.0.0",
    "intentName": "sales.custom",
    "description": "Custom sales view",
}


# --- binding/action ---------------------------------------------------------


def test_binding_action_requires_capability(client: Any) -> None:
    res = client.post(_url("/binding/action"), json={"action": "sales.update", "payload": {}})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "CAPABILITY_REQUIRED"


def test_binding_action_bad_request(client: Any) -> None:
    res = client.post(
        _url("/binding/action"),
        json={"payload": {}},
        headers={"authorization": "Bearer x"},
    )
    assert res.status_code == 400


def test_binding_action_rejects_non_object_payload(client: Any) -> None:
    """DomainPort.invoke's args contract is an object of named params; an array/string payload is 400 (port
    of the TS ActionBodySchema JsonObjectSchema check)."""
    for bad_payload in (["nope"], "nope"):
        res = client.post(
            _url("/binding/action"),
            json={"action": "sales.update", "payload": bad_payload},
            headers={"authorization": "Bearer x"},
        )
        assert res.status_code == 400, bad_payload
        assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_binding_action_denied_for_unknown_token(client: Any) -> None:
    res = client.post(
        _url("/binding/action"),
        json={"action": "sales.update", "payload": {}},
        headers={"authorization": "Bearer nope"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "CAPABILITY_DENIED"


class _AuthzOkNoPrincipal:
    """authz.verify always returns ok=True with no principal (a capability-issuer misconfiguration to guard against)."""

    async def issue_capability(self, principal: Any, scopes: Any, *, ttl_seconds: Any = None) -> str:
        return "cap"

    async def verify(self, token: str, req: Any) -> Any:
        from kohaku.spec import VerifyResult

        return VerifyResult(ok=True)


def test_binding_action_verify_ok_without_principal_denied_when_auth_wired(tmp_path: Path) -> None:
    """When deps.auth is wired (real authentication), a verify() that returns ok=True without a principal must
    not silently degrade to ANONYMOUS (it would let an authenticated deployment act as the demo user)."""
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(catalog=catalog, semantic=FakeSemantic(), storage=storage, llm=FakeLlm())
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=_AuthzOkNoPrincipal(),
        query_source="sales",
        auth=lambda _request: Principal(id="u", roles=["user"]),
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)
    res = client.post(
        _url("/binding/action"),
        json={"action": "annotate", "payload": {}},
        headers={"authorization": "Bearer x"},
    )
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "CAPABILITY_DENIED"


def test_binding_action_verify_ok_without_principal_falls_back_to_anonymous_when_auth_unwired(
    tmp_path: Path,
) -> None:
    """When deps.auth is unwired (the unauthenticated demo path), ANONYMOUS is the expected principal."""
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(catalog=catalog, semantic=FakeSemantic(), storage=storage, llm=FakeLlm())
    deps = KohakuHostDeps(
        compose=ctx, domain=FakeDomain(), authz=_AuthzOkNoPrincipal(), query_source="sales"
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)
    res = client.post(
        _url("/binding/action"),
        json={"action": "annotate", "payload": {}},
        headers={"authorization": "Bearer x"},
    )
    assert res.status_code == 200


def test_binding_action_success_with_effects(tmp_path: Path) -> None:
    async def effects(action: str, payload: Any, result: Any) -> ActionEffects:
        return ActionEffects(
            invalidates=["query://sales/summary"],
            refVersions={"query://sales/summary": "v2"},
        )

    harness = build_harness(tmp_path, action_effects=effects)
    token = harness.issue([Scope(kind="write", ref="sales.update")])
    res = harness.client.post(
        _url("/binding/action"),
        json={"action": "sales.update", "payload": {"target": 100}},
        headers={"authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["result"]["ok"] is True
    assert body["invalidates"] == ["query://sales/summary"]
    assert body["refVersions"] == {"query://sales/summary": "v2"}


def test_binding_action_effects_failure_still_succeeds(tmp_path: Path) -> None:
    """Even if action_effects raises, the committed write returns success (only {result}) and the failure is recorded to on_error."""
    captured: list[HostErrorInfo] = []

    async def effects(action: str, payload: Any, result: Any) -> ActionEffects:
        raise RuntimeError("effects computation failed (test)")

    def on_error(info: HostErrorInfo) -> None:
        captured.append(info)

    harness = build_harness(tmp_path, action_effects=effects, on_error=on_error)
    token = harness.issue([Scope(kind="write", ref="sales.update")])
    res = harness.client.post(
        _url("/binding/action"),
        json={"action": "sales.update", "payload": {"target": 100}},
        headers={"authorization": f"Bearer {token}"},
    )
    # The write is already committed, so 200. The failed effects are omitted, leaving the backward-compatible {result} only.
    assert res.status_code == 200
    body = res.json()
    assert body["result"]["ok"] is True
    assert "invalidates" not in body
    assert "refVersions" not in body
    # The failure is recorded to observability (on_error) (delivery is not dragged down).
    assert any(info.endpoint == "binding/action" for info in captured)


# --- binding/resolve error paths --------------------------------------------


def test_binding_resolve_source_mismatch(client: Any) -> None:
    res = client.get(
        _url("/binding/resolve"),
        params={"ref": "query://other/x?a=1"},
        headers={"authorization": "Bearer x"},
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "SOURCE_MISMATCH"


def test_binding_resolve_unknown_reserved_param(client: Any) -> None:
    res = client.get(
        _url("/binding/resolve"),
        params={"ref": "query://sales/summary?fy=2026&_bogus=1"},
        headers={"authorization": "Bearer x"},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_binding_resolve_reserved_param_passthrough(client: Any) -> None:
    """A reserved parameter (_limit) is stripped back to the base ref for capability verification and merged into domain."""
    body = client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()
    capability = body["capability"]
    res = client.get(
        _url("/binding/resolve"),
        params={"ref": "query://sales/summary?fy=2026&_limit=10"},
        headers={"authorization": f"Bearer {capability}"},
    )
    assert res.status_code == 200
    assert res.json()["dataVersion"] == "v1"


def test_binding_resolve_ref_not_found_with_request_id(tmp_path: Path) -> None:
    captured: list[HostErrorInfo] = []

    def on_error(info: HostErrorInfo) -> None:
        captured.append(info)

    harness = build_harness(tmp_path, on_error=on_error)
    token = harness.issue([Scope(kind="read", ref="query://sales/boom")])
    res = harness.client.get(
        _url("/binding/resolve"),
        params={"ref": "query://sales/boom"},
        headers={"authorization": f"Bearer {token}"},
    )
    assert res.status_code == 404
    error = res.json()["error"]
    assert error["code"] == "REF_NOT_FOUND"
    assert isinstance(error.get("requestId"), str)
    assert any(info.endpoint == "binding/resolve" for info in captured)
    assert error["requestId"] in {info.request_id for info in captured}


# --- telemetry --------------------------------------------------------------


def test_telemetry_records_events(client: Any) -> None:
    res = client.post(
        _url("/telemetry"),
        json={
            "events": [
                {"kind": "rendered", "specHash": "sha256:" + "a" * 64, "renderer": "react"},
                {"kind": "componentUsed", "artifactId": "art-1", "outcome": "ok"},
            ]
        },
    )
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    lineage = client.get(_url("/lineage"), params={"limit": 1000}).json()["events"]
    types = {e["type"] for e in lineage}
    assert "view.rendered" in types
    assert "component.used" in types


def test_telemetry_rejects_oversized_batch(client: Any) -> None:
    events = [{"kind": "rendered", "specHash": "sha256:" + "a" * 64} for _ in range(501)]
    res = client.post(_url("/telemetry"), json={"events": events})
    assert res.status_code == 400


def test_telemetry_bad_body(client: Any) -> None:
    assert client.post(_url("/telemetry"), json={}).status_code == 400


# --- analytics/summary ------------------------------------------------------


def test_analytics_summary(client: Any) -> None:
    client.post(_url("/compose"), json={"intent": INTENT_BODY})
    res = client.get(_url("/analytics/summary"))
    assert res.status_code == 200
    body = res.json()
    assert body["window"]["limit"] == 200
    assert isinstance(body["summary"]["events"], int)
    assert body["summary"]["events"] >= 1


def test_analytics_not_implemented(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, with_analytics=False)
    res = harness.client.get(_url("/analytics/summary"))
    assert res.status_code == 501
    assert res.json()["error"]["code"] == "NOT_IMPLEMENTED"


def test_analytics_bad_since(client: Any) -> None:
    res = client.get(_url("/analytics/summary"), params={"since": "July 9, 2026"})
    assert res.status_code == 400


def test_lineage_bad_since(client: Any) -> None:
    res = client.get(_url("/lineage"), params={"since": "not-a-date"})
    assert res.status_code == 400


def test_lineage_bad_until(client: Any) -> None:
    # Like since, until is 400 for anything other than ISO8601 (the same canonicalization / boundary interpretation as /analytics/summary).
    res = client.get(_url("/lineage"), params={"until": "July 9, 2026"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_lineage_until_filters_events(client: Any) -> None:
    # compose once to create a lineage event (view.composed).
    assert client.post(_url("/compose"), json={"intent": INTENT_BODY}).status_code == 200
    # A far-past until yields 0 events (out of bounds); a sufficiently future one keeps the record.
    past = client.get(_url("/lineage"), params={"until": "2000-01-01"}).json()["events"]
    future = client.get(_url("/lineage"), params={"until": "2999-01-01"}).json()["events"]
    assert past == []
    assert len(future) >= 1


# --- Governance plane authorization ------------------------------------


def test_governance_denies_promotion_but_allows_lineage(tmp_path: Path) -> None:
    # The anonymous principal's role is ["user"]. user is permitted lineage.read only.
    policy = create_governance_policy(GovernancePolicy(roles={"user": ["lineage.read"]}))
    harness = build_harness(tmp_path, authorize_governance=policy)
    assert harness.client.get(_url("/lineage")).status_code == 200
    denied = harness.client.get(_url("/promotions"))
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "CAPABILITY_DENIED"


def test_governance_evaluator_direct() -> None:
    policy = create_governance_policy(
        GovernancePolicy(roles={"reviewer": ["promotion.*", "lineage.read"], "viewer": ["lineage.read"]})
    )
    reviewer = Principal(id="r", roles=["reviewer"])
    viewer = Principal(id="v", roles=["viewer"])
    assert policy(reviewer, GovernanceOperation(kind="promotion.approve"), None) is True
    assert policy(viewer, GovernanceOperation(kind="promotion.approve"), None) is False
    assert policy(viewer, GovernanceOperation(kind="lineage.read"), None) is True
    # Unknown role / out of permissions is denied (deny-by-default).
    assert policy(Principal(id="x", roles=["ghost"]), GovernanceOperation(kind="lineage.read"), None) is False


def test_governance_evaluator_tenant_of_denies_cross_tenant_even_for_wildcard_role() -> None:
    """§4.4 Minor: tenant_of closes the gap where a role grant (even `*`) could reach any tenant."""
    policy = create_governance_policy(
        GovernancePolicy(roles={"admin": ["*"]}, tenant_of=lambda _principal: "acme")
    )
    admin = Principal(id="a", roles=["admin"])
    assert policy(admin, GovernanceOperation(kind="promotion.approve"), "acme") is True
    assert policy(admin, GovernanceOperation(kind="promotion.approve"), "globex") is False
    assert policy(admin, GovernanceOperation(kind="lineage.read"), "globex") is False
    # No tenant resolved at all (None) also mismatches tenant_of's "acme".
    assert policy(admin, GovernanceOperation(kind="promotion.approve"), None) is False


def test_governance_evaluator_without_tenant_of_reaches_any_tenant() -> None:
    """Without tenant_of, the historical role-only behavior is unchanged."""
    policy = create_governance_policy(GovernancePolicy(roles={"admin": ["*"]}))
    admin = Principal(id="a", roles=["admin"])
    assert policy(admin, GovernanceOperation(kind="promotion.approve"), "globex") is True


def test_governance_route_tenant_of_denies_cross_tenant(tmp_path: Path) -> None:
    """Route integration: admin's `*` role grant is denied at a tenant it is not tenant_of'd to, even though
    the same request would be allowed with no tenant-scoping policy at all."""
    policy = create_governance_policy(
        GovernancePolicy(roles={"admin": ["*"]}, tenant_of=lambda _principal: "acme")
    )
    harness = build_harness(
        tmp_path,
        authorize_governance=policy,
        auth=role_auth("admin"),
        tenant=lambda request: request.headers.get("x-kohaku-tenant"),
    )

    ok = harness.client.get(_url("/lineage"), headers={"x-kohaku-tenant": "acme"})
    assert ok.status_code == 200

    denied = harness.client.get(_url("/lineage"), headers={"x-kohaku-tenant": "globex"})
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "CAPABILITY_DENIED"


_GOV_LOGGER = "kohaku.host_rest._fastapi_routes"


def test_governance_unwired_emits_startup_warning(tmp_path: Path, caplog: Any) -> None:
    # If authorize_governance is unwired (default), emit the fail-open startup warning once (Major-2, partial).
    with caplog.at_level(logging.WARNING, logger=_GOV_LOGGER):
        build_harness(tmp_path)
    warnings = [
        r for r in caplog.records if "deps.authorize_governance" in r.getMessage()
    ]
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING


def test_promotion_act_alone_cannot_reach_kind_scoped_actions(tmp_path: Path) -> None:
    """A role holding only promotion.act cannot perform review.approve/publish/schema.propose/review.reject/
    withdraw/unpublish/judge.result via the generic actions route (mirrors TS governance.test.ts)."""
    policy = create_governance_policy(GovernancePolicy(roles={"user": ["promotion.act"]}))
    harness = build_harness(tmp_path, authorize_governance=policy)
    _seed_generated(harness, "art-kind-scoped")
    url = _url("/promotions/art-kind-scoped/actions")

    def denied(action: dict[str, Any]) -> None:
        res = harness.client.post(url, json={"action": action})
        assert res.status_code == 403, action
        assert res.json()["error"]["code"] == "CAPABILITY_DENIED"

    denied({"kind": "review.approve"})
    denied({"kind": "publish", "version": "1.0.0"})
    denied({"kind": "schema.propose", "draft": _DRAFT})
    denied({"kind": "review.reject"})
    denied({"kind": "withdraw"})
    denied({"kind": "unpublish"})
    denied({"kind": "judge.result", "verdict": {"pass": True, "score": 1}})

    # Kinds with no dedicated named route to mirror still pass with promotion.act alone. nominate (in_use ->
    # candidate) is the prerequisite for judge.start / review.start (candidate -> judging / in_review), so each
    # is exercised on its own freshly-seeded artifact via a nominate -> {judge.start|review.start} pair.
    def act(artifact_id: str, action: dict[str, Any]) -> int:
        res = harness.client.post(_url(f"/promotions/{artifact_id}/actions"), json={"action": action})
        return int(res.status_code)

    _seed_generated(harness, "art-nominate")
    assert act("art-nominate", {"kind": "nominate"}) == 200

    _seed_generated(harness, "art-judge-start")
    assert act("art-judge-start", {"kind": "nominate"}) == 200
    assert act("art-judge-start", {"kind": "judge.start"}) == 200

    _seed_generated(harness, "art-review-start")
    assert act("art-review-start", {"kind": "nominate"}) == 200
    assert act("art-review-start", {"kind": "review.start"}) == 200


def test_judge_result_requires_promotion_judge(tmp_path: Path) -> None:
    policy = create_governance_policy(
        GovernancePolicy(roles={"user": ["promotion.act", "promotion.judge"]})
    )
    harness = build_harness(tmp_path, authorize_governance=policy)
    _seed_generated(harness, "art-judge")
    url = _url("/promotions/art-judge/actions")
    # judge.result is only a valid transition from "judging" (in_use -> candidate -> judging).
    assert harness.client.post(url, json={"action": {"kind": "nominate"}}).status_code == 200
    assert harness.client.post(url, json={"action": {"kind": "judge.start"}}).status_code == 200
    res = harness.client.post(
        url, json={"action": {"kind": "judge.result", "verdict": {"pass": True, "score": 1}}}
    )
    assert res.status_code == 200


def test_governance_wired_no_startup_warning(tmp_path: Path, caplog: Any) -> None:
    # When wired, no warning is emitted (the fail-open default itself is unchanged).
    policy = create_governance_policy(GovernancePolicy(roles={"user": ["lineage.read"]}))
    with caplog.at_level(logging.WARNING, logger=_GOV_LOGGER):
        build_harness(tmp_path, authorize_governance=policy)
    assert not any(
        "deps.authorize_governance" in r.getMessage() for r in caplog.records
    )


def test_auth_unwired_emits_startup_warning(tmp_path: Path, caplog: Any) -> None:
    # Symmetric with the authorize_governance warning: unwired deps.auth means every request is ANONYMOUS.
    with caplog.at_level(logging.WARNING, logger=_GOV_LOGGER):
        build_harness(tmp_path)
    warnings = [r for r in caplog.records if "deps.auth is not wired" in r.getMessage()]
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING


def test_auth_wired_no_startup_warning(tmp_path: Path, caplog: Any) -> None:
    with caplog.at_level(logging.WARNING, logger=_GOV_LOGGER):
        build_harness(tmp_path, auth=lambda _request: Principal(id="u", roles=["user"]))
    assert not any("deps.auth is not wired" in r.getMessage() for r in caplog.records)


# --- Promotion lifecycle ----------------------------------------------------


def test_promotions_get_404(client: Any) -> None:
    res = client.get(_url("/promotions/does-not-exist"))
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"


def test_promotions_actions_nominate(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed_generated(harness, "art-2")
    res = harness.client.post(
        _url("/promotions/art-2/actions"), json={"action": {"kind": "nominate"}}
    )
    assert res.status_code == 200
    assert res.json()["candidate"]["status"] == "candidate"


def test_promotions_reject(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed_generated(harness, "art-3")
    res = harness.client.post(_url("/promotions/art-3/reject"))
    assert res.status_code == 200
    assert res.json()["candidate"]["status"] == "rejected"


def test_promotions_withdraw_after_publish(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed_generated(harness, "art-4", with_preview=True)
    approve = harness.client.post(_url("/promotions/art-4/approve"), json={"draft": _DRAFT})
    assert approve.status_code == 200
    withdraw = harness.client.post(
        _url("/promotions/art-4/withdraw"), json={"reason": "withdrawal"}
    )
    assert withdraw.status_code == 200
    assert withdraw.json()["candidate"]["status"] == "withdrawn"


def test_promotions_evaluate_returns_list(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed_generated(harness, "art-5")
    res = harness.client.post(_url("/promotions/evaluate"))
    assert res.status_code == 200
    assert isinstance(res.json()["candidates"], list)


def test_promotions_reconcile_returns_summary(tmp_path: Path) -> None:
    """POST /promotions/reconcile (#11): 200 with the real reconcile() summary, wired with the actual
    create_promotions pipeline (not a fake). build_harness's pipeline has no on_publish/on_unpublish wired
    (no projection to reconcile), so reconcile() short-circuits to an all-zero summary — this exercises the
    route's plumbing (governance check, promotion lock, response shape) end to end against the real service."""
    harness = build_harness(tmp_path)
    _seed_generated(harness, "art-6", with_preview=True)
    approve = harness.client.post(_url("/promotions/art-6/approve"), json={"draft": _DRAFT})
    assert approve.status_code == 200

    res = harness.client.post(_url("/promotions/reconcile"))
    assert res.status_code == 200
    assert res.json()["summary"] == {"published": 0, "withdrawn": 0, "skipped": 0}


def test_promotions_reconcile_501_when_promotions_not_configured(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, with_promotions=False)
    res = harness.client.post(_url("/promotions/reconcile"))
    assert res.status_code == 501


def test_promotions_reconcile_denied_by_governance(tmp_path: Path) -> None:
    harness = build_harness(
        tmp_path,
        authorize_governance=lambda principal, operation, tenant: operation.kind != "promotion.reconcile",
    )
    res = harness.client.post(_url("/promotions/reconcile"))
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "CAPABILITY_DENIED"


class _FakeNotPublished(Exception):
    """Structurally represents PromotionNotPublishedError (host_rest discriminates by `code`, not by importing lineage)."""

    code = "PROMOTION_NOT_PUBLISHED"
    status = "judge_failed"
    name = "PromotionNotPublishedError"


class _FakePromotionsRaisingNotPublished:
    """A minimal PromotionsApi stub whose approve() always raises _FakeNotPublished."""

    async def list_candidates(self, *, tenant: str | None = None) -> list[Any]:
        return []

    async def list_by_status(self, status: Any, *, tenant: str | None = None) -> list[Any]:
        return []

    async def get(self, artifact_id: str, tenant: str | None = None) -> Any:
        return {"artifactId": artifact_id}

    async def evaluate_and_list(self, *, tenant: str | None = None) -> list[Any]:
        return []

    async def act(self, artifact_id: str, action: Any, actor: Principal, tenant: str | None = None) -> Any:
        raise NotImplementedError

    async def approve(
        self, artifact_id: str, draft: Any, reviewer: Principal, tenant: str | None = None
    ) -> Any:
        raise _FakeNotPublished("approval did not reach published")

    async def reject(self, artifact_id: str, reviewer: Principal, tenant: str | None = None) -> Any:
        raise NotImplementedError

    async def withdraw(
        self, artifact_id: str, actor: Principal, reason: str | None = None, tenant: str | None = None
    ) -> Any:
        raise NotImplementedError

    async def reconcile(self) -> Any:
        raise NotImplementedError


def test_promotions_approve_not_published_envelope_carries_status(tmp_path: Path) -> None:
    """The 409 PROMOTION_NOT_PUBLISHED envelope carries the stopped promotion state in error.status
    (distinct from the HTTP status code), mirroring the TS wire contract (rest-errors.ts ErrorEnvelope.status)."""
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(
        catalog=catalog,
        semantic=FakeSemantic(),
        storage=storage,
        llm=FakeLlm(),
    )
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        promotions=_FakePromotionsRaisingNotPublished(),
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)

    res = client.post(_url("/promotions/art-np/approve"), json={"draft": _DRAFT})
    assert res.status_code == 409
    body = res.json()
    assert body["error"]["code"] == "PROMOTION_NOT_PUBLISHED"
    assert body["error"]["status"] == "judge_failed"


def test_promotions_preview(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed_generated(harness, "art-6", with_preview=True)
    res = harness.client.post(_url("/promotions/art-6/preview"))
    assert res.status_code == 200
    preview = res.json()["preview"]
    assert preview["html"].startswith("<!DOCTYPE html>")
    assert preview["ref"] == harness.ref
    # The issued read capability can resolve that ref.
    resolved = harness.client.get(
        _url("/binding/resolve"),
        params={"ref": preview["ref"]},
        headers={"authorization": f"Bearer {preview['capability']}"},
    )
    assert resolved.status_code == 200


# --- Fixation (L1->L0) ------------------------------------------------------


def test_fixation_approve_shortcircuits_compose(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    # compose first to warm the cache (stabilizes the fixation's pinnedSpec).
    harness.client.post(_url("/compose"), json={"intent": INTENT_BODY})

    approve = harness.client.post(_url("/fixations/approve"), json={"intent": INTENT_BODY})
    assert approve.status_code == 200
    intent_hash = approve.json()["fixation"]["intentHash"]

    listed = harness.client.get(_url("/fixations")).json()["fixations"]
    assert any(f["intentHash"] == intent_hash for f in listed)

    # Fixation short-circuit: compose returns L0 / fixated.
    spec = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    assert spec["provenance"]["tier"] == "L0"
    assert spec["provenance"]["cache"] == "fixated"

    # After removal the fixation short-circuit is gone.
    removed = harness.client.post(_url(f"/fixations/{intent_hash}/remove"))
    assert removed.status_code == 200
    assert harness.client.get(_url("/fixations")).json()["fixations"] == []
    spec2 = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    assert spec2["provenance"]["cache"] != "fixated"


def test_fixation_approve_rejects_fallback_spec(tmp_path: Path) -> None:
    """A generation failure must not be pinned as L0 for everyone: with no scripted LLM response and
    allow_l2 False, compose falls back to the deterministic presentMarkdown Spec, and approve refuses it."""
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(
        catalog=catalog,
        semantic=FakeSemantic(),
        storage=storage,
        llm=FakeLlm(),  # no scripted response: generate_object always raises
        policy=ComposePolicy(allowL2=False),
    )
    lineage = create_lineage(storage)
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        fixations=create_fixations(lineage=lineage, storage=storage, catalog_for=lambda _t: catalog),
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)

    res = client.post(_url("/fixations/approve"), json={"intent": INTENT_BODY})
    assert res.status_code == 422
    body = res.json()
    assert body["error"]["code"] == "COMPOSE_FAILED"
    assert "a fallback Spec cannot be fixated" in body["error"]["message"]
    assert asyncio.run(storage.list_fixations()) == []


def test_fixation_approve_rejects_l2_spec(tmp_path: Path) -> None:
    """An L2 free-form cached result is governed by the promotion pipeline (L2->L1), not fixation."""
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(
        catalog=catalog,
        semantic=FakeSemantic(),
        storage=storage,
        llm=FakeLlm(),
    )
    lineage = create_lineage(storage)
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        fixations=create_fixations(lineage=lineage, storage=storage, catalog_for=lambda _t: catalog),
    )

    # Precompute the same cache key /fixations/approve's compose path will look up (FakeSemantic returns
    # data_version "v1" for the single resolved handle) and seed it with an already-composed L2 result.
    intent = finalize_intent(IntentInput(canonical="sales.summary", params={"fy": 2026}))
    key = cache_key(
        CacheKeyParts(intentHash=intent.hash, dataVersion="v1", catalogFingerprint=catalog.fingerprint)
    )
    l2_spec = UISpec(
        kohaku="0.1",
        intent=intent,
        dataVersion="v1",
        components=[
            ComponentNode(id="root", type="sandbox.html", props={"html": "<div>free-form</div>"})
        ],
        events=[],
        provenance=Provenance(tier="L2", composedBy="fixture", cache="miss"),
    )
    asyncio.run(storage.put_spec_cache(key, l2_spec))

    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)

    res = client.post(_url("/fixations/approve"), json={"intent": INTENT_BODY})
    assert res.status_code == 400
    body = res.json()
    assert body["error"]["code"] == "BAD_REQUEST"
    assert "governed by the promotion pipeline" in body["error"]["message"]
    assert asyncio.run(storage.list_fixations()) == []


def test_fixation_approve_masks_unexpected_fixate_failure(tmp_path: Path) -> None:
    """§4.2 Q6: an unexpected failure past the fallback/L2 guards (e.g. the storage write inside
    fixations.fixate) must mask a raw exception's message the same way /compose's COMPOSE_FAILED does, while
    the original error still reaches the observability hook (mirrors TS fixation-approve.test.ts)."""
    seen: list[HostErrorInfo] = []

    def on_error(info: HostErrorInfo) -> None:
        seen.append(info)

    harness = build_harness(tmp_path, on_error=on_error)
    # An L0 fixed template with no fallback, so approve gets past the fallback/L2 guards and reaches
    # fixations.fixate below them.
    _with_fixed_specs(harness)

    async def _boom(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("secret internal detail")

    harness.storage.put_fixation = _boom  # type: ignore[method-assign]

    res = harness.client.post(_url("/fixations/approve"), json={"intent": INTENT_BODY})
    assert res.status_code == 500
    body = res.json()
    assert body["error"]["code"] == "COMPOSE_FAILED"
    assert "secret internal detail" not in body["error"]["message"]

    assert len(seen) == 1
    assert seen[0].endpoint == "fixations/approve"
    assert isinstance(seen[0].error, RuntimeError)
    assert str(seen[0].error) == "secret internal detail"


def test_fixations_proposals_empty(client: Any) -> None:
    res = client.get(_url("/fixations/proposals"))
    assert res.status_code == 200
    assert res.json()["proposals"] == []


def test_fixations_not_configured(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, with_fixations=False)
    assert harness.client.get(_url("/fixations")).status_code == 501
    assert harness.client.get(_url("/fixations/proposals")).status_code == 501
    assert (
        harness.client.post(_url("/fixations/approve"), json={"intent": INTENT_BODY}).status_code
        == 501
    )
    assert harness.client.post(_url("/fixations/somehash/remove")).status_code == 501


# --- catalog / intent normalize ---------------------------------------------


def test_catalog_component_shape(client: Any) -> None:
    body = client.get(_url("/catalog")).json()
    first = body["components"][0]
    assert first["implementation"]["kind"] in ("native", "sandbox-template")
    assert "events" in first["capabilities"]


def test_intent_normalize_nl_source(client: Any) -> None:
    res = client.post(
        _url("/intent/normalize"),
        json={"input": {"kind": "nl", "text": "Show me this quarter's sales summary"}},
    )
    assert res.status_code == 200
    assert res.json()["source"] == "llm"


# --- Write scopes restricted to DomainPort operations -----------------------


def _annotate_fixed_spec() -> UISpec:
    """A minimal L0 fixed Spec declaring presentForm(action=annotate) + a matching action.invoke event, plus
    a $ref matching conftest.REF (so the read scope lines up with FakeSemantic.resolve_query's fixed handle).
    Only .components / .events / .state are read by the composer's L0 short-circuit (_try_fixed_spec) — the
    rest of this UISpec is placeholder to satisfy model validation.
    """
    intent = finalize_intent(IntentInput(canonical="ignored", params={}))
    data: dict[str, Any] = {
        "kohaku": "0.1",
        "intent": intent.to_wire(),
        "dataVersion": "ignored",
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["f", "t"]},
            {
                "id": "f",
                "type": "presentForm",
                "props": {"action": "annotate", "fields": [{"name": "note", "type": "text", "label": "Note"}]},
            },
            {"id": "t", "type": "presentSpreadsheet", "props": {"editable": False}, "data": {"$ref": REF}},
        ],
        "events": [{"on": "f.submit", "emit": "action.invoke", "payload": {"note": "$value.note", "refs": [REF]}}],
        "provenance": {"tier": "L0", "composedBy": "fixture", "cache": "miss"},
    }
    return UISpec.model_validate(data)


class _AnnotateFixedSpecs:
    """FixedSpecSource that always resolves to _annotate_fixed_spec() (deterministic w.r.t. intent)."""

    async def lookup(self, intent: Any) -> UISpec:
        return _annotate_fixed_spec()


def _with_fixed_specs(harness: Harness) -> None:
    """Swaps harness's ComposeContext to one whose policy declares fixedSpecs, so /compose(/stream) resolves
    the L0 fixed Spec above without going through L1/LLM generation. KohakuHostDeps is a plain mutable
    dataclass, so this mutates in place (the routes read deps.compose fresh per request)."""
    harness.deps.compose = dataclasses.replace(
        harness.ctx, policy=ComposePolicy(fixedSpecs=_AnnotateFixedSpecs())
    )


def _spec_event_capability(sse_text: str) -> str:
    """Extracts the capability of the first `event: spec` block from raw SSE text."""
    for block in sse_text.split("\n\n"):
        lines = block.split("\n")
        if not any(line.strip() == "event: spec" for line in lines):
            continue
        data_line = next((line for line in lines if line.startswith("data:")), None)
        if data_line is None:
            continue
        payload: dict[str, Any] = json.loads(data_line[len("data:") :].strip())
        return str(payload["capability"])
    raise AssertionError("spec event not found in SSE")


def test_stream_final_true_carries_write_scope(tmp_path: Path) -> None:
    """/compose/stream's final:true path (composer's own L0-fixed-Spec match, not the host-level fixation
    shortcut) now issues from the Spec, so an action.invoke it declares carries a write scope end to end.
    """
    harness = build_harness(tmp_path)
    _with_fixed_specs(harness)

    res = harness.client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    capability = _spec_event_capability(res.text)

    action_res = harness.client.post(
        _url("/binding/action"),
        json={"action": "annotate", "payload": {"note": "hi", "refs": [REF]}},
        headers={"authorization": f"Bearer {capability}"},
    )
    assert action_res.status_code == 200
    assert action_res.json()["result"]["ok"] is True


def test_unlisted_action_write_scope_dropped_and_on_error_notified(tmp_path: Path) -> None:
    captured: list[HostErrorInfo] = []

    def on_error(info: HostErrorInfo) -> None:
        captured.append(info)

    class NoAnnotateDomain:
        async def list_operations(self) -> list[OperationDescriptor]:
            return []

        async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
            return {"ok": True, "op": op, "args": args}

    harness = build_harness(tmp_path, on_error=on_error)
    _with_fixed_specs(harness)
    harness.deps.domain = NoAnnotateDomain()

    res = harness.client.post(_url("/compose"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    capability = res.json()["capability"]

    assert any(
        info.endpoint == "compose" and isinstance(info.error, WriteScopeDroppedError)
        for info in captured
    )

    action_res = harness.client.post(
        _url("/binding/action"),
        json={"action": "annotate", "payload": {"note": "hi", "refs": [REF]}},
        headers={"authorization": f"Bearer {capability}"},
    )
    assert action_res.status_code == 403


def test_stream_final_over_variant_limit_emits_error_event(tmp_path: Path) -> None:
    """A final Spec over MAX_BIND_VARIANTS now raises inside issue_capability_for_spec's
    collect_capability_scopes (same as /compose), so /compose/stream terminates with event: error
    COMPOSE_FAILED instead of silently truncating the capability's read scopes.
    """

    class OversizedBindFixedSpecs:
        async def lookup(self, intent: Any) -> UISpec:
            values = [f"r{i}" for i in range(257)]
            fixed_intent = finalize_intent(IntentInput(canonical="ignored", params={}))
            data: dict[str, Any] = {
                "kohaku": "0.2",
                "intent": fixed_intent.to_wire(),
                "dataVersion": "ignored",
                "state": {"region": "r0"},
                "components": [
                    {"id": "root", "type": "layout.stack", "props": {}, "children": ["kpi"]},
                    {
                        "id": "kpi",
                        "type": "presentMetric",
                        "props": {"label": "Revenue", "valueColumn": "revenue"},
                        "data": {
                            "$ref": REF,
                            "bind": {"region": {"$state": "region", "values": values}},
                        },
                    },
                ],
                "events": [],
                "provenance": {"tier": "L0", "composedBy": "fixture", "cache": "miss"},
            }
            return UISpec.model_validate(data)

    harness = build_harness(tmp_path)
    harness.deps.compose = dataclasses.replace(
        harness.ctx, policy=ComposePolicy(fixedSpecs=OversizedBindFixedSpecs())
    )

    res = harness.client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    assert "event: error" in res.text
    for block in res.text.split("\n\n"):
        if "event: error" not in block:
            continue
        data_line = next(line for line in block.split("\n") if line.startswith("data:"))
        payload = json.loads(data_line[len("data:") :].strip())
        assert payload["error"]["code"] == "COMPOSE_FAILED"
        break
    else:
        raise AssertionError("error event not found in SSE")


# --- Serialization lock cleanup (SRE-2/DB-2) --------------------------------


def test_serialize_lock_entry_is_cleaned_after_use(harness: Harness) -> None:
    """The serialization lock exists in _locks only while in use and is cleaned up once the last user leaves."""
    from kohaku.host_rest import _fastapi_routes as fr

    async def run() -> None:
        key = "test-cleanup-key"
        async with fr._get_lock(harness.deps, key):
            # While in use the entry exists.
            assert any(k[2] == key for k in fr._locks)
        # After use the unused entry disappears (prevents a leak from monotonic growth).
        assert not any(k[2] == key for k in fr._locks)

    asyncio.run(run())


def test_serialize_lock_survives_while_contended(harness: Harness) -> None:
    """While a waiter remains the entry is retained, and it is cleaned up only once all users leave."""
    from kohaku.host_rest import _fastapi_routes as fr

    async def run() -> None:
        key = "test-contended-key"
        started = asyncio.Event()
        release = asyncio.Event()

        async def _holder() -> None:
            async with fr._get_lock(harness.deps, key):
                started.set()
                await release.wait()

        holder = asyncio.ensure_future(_holder())
        await started.wait()

        async def _waiter() -> None:
            async with fr._get_lock(harness.deps, key):
                pass

        waiter = asyncio.ensure_future(_waiter())
        await asyncio.sleep(0)  # let the waiter enter the lock wait
        # While the holder + waiter remain the entry exists.
        assert any(k[2] == key for k in fr._locks)
        release.set()
        await asyncio.gather(holder, waiter)
        # Once all users leave it is cleaned up.
        assert not any(k[2] == key for k in fr._locks)

    asyncio.run(run())


# --- Correlation id propagation (ops) -------------------------------------------
# Port of TS packages/host-rest/test/request-id.test.ts: the inbound x-request-id request header (when present
# and well-formed) is echoed as the X-Request-Id response header and reused for error.requestId; a missing or
# malformed header falls back to a freshly minted uuid4. See _routes/shared.py's request_id_of.

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def test_request_id_echoed_on_success_response(client: Any) -> None:
    res = client.get(_url("/catalog"), headers={"x-request-id": "caller-supplied-id-123"})
    assert res.status_code == 200
    assert res.headers["x-request-id"] == "caller-supplied-id-123"


def test_request_id_echoed_on_error_response_and_matches_envelope(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    token = harness.issue([Scope(kind="read", ref="query://sales/boom")])
    res = harness.client.get(
        _url("/binding/resolve"),
        params={"ref": "query://sales/boom"},
        headers={"authorization": f"Bearer {token}", "x-request-id": "trace-abc-999"},
    )
    assert res.status_code == 404
    body = res.json()
    assert res.headers["x-request-id"] == "trace-abc-999"
    assert body["error"]["requestId"] == "trace-abc-999"


def test_request_id_generated_when_header_absent(client: Any) -> None:
    res = client.get(_url("/catalog"))
    assert res.status_code == 200
    assert _UUID_RE.match(res.headers["x-request-id"])


def test_request_id_oversized_header_replaced(client: Any) -> None:
    res = client.get(_url("/catalog"), headers={"x-request-id": "x" * 200})
    assert res.status_code == 200
    assert _UUID_RE.match(res.headers["x-request-id"])


def test_request_id_whitespace_only_header_replaced(client: Any) -> None:
    res = client.get(_url("/catalog"), headers={"x-request-id": "   "})
    assert res.status_code == 200
    assert _UUID_RE.match(res.headers["x-request-id"])


def test_request_id_same_id_reused_for_response_header_envelope_and_on_error(
    tmp_path: Path,
) -> None:
    captured: list[HostErrorInfo] = []

    def on_error(info: HostErrorInfo) -> None:
        captured.append(info)

    harness = build_harness(tmp_path, on_error=on_error)
    token = harness.issue([Scope(kind="read", ref="query://sales/boom")])
    res = harness.client.get(
        _url("/binding/resolve"),
        params={"ref": "query://sales/boom"},
        headers={"authorization": f"Bearer {token}", "x-request-id": "one-id-for-everything"},
    )
    assert res.status_code == 404
    body = res.json()
    assert res.headers["x-request-id"] == "one-id-for-everything"
    assert body["error"]["requestId"] == "one-id-for-everything"
    assert [info.request_id for info in captured] == ["one-id-for-everything"]


def test_request_id_hook_override(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    harness.deps.request_id = lambda request: "fixed-product-id"
    res = harness.client.get(_url("/catalog"), headers={"x-request-id": "should-be-ignored"})
    assert res.headers["x-request-id"] == "fixed-product-id"


def test_request_id_not_stamped_outside_prefix(tmp_path: Path) -> None:
    """RequestIdASGIMiddleware only stamps routes under the kohaku prefix, not other routes on the same app."""
    harness = build_harness(tmp_path)
    app: Any = harness.client.app

    def _outside() -> dict[str, bool]:
        return {"ok": True}

    app.get("/outside")(_outside)

    res = harness.client.get("/outside")
    assert res.status_code == 200
    assert "x-request-id" not in {k.lower() for k in res.headers}


# --- W3C trace context propagation (ops) ------------------------------------
# Port note: unlike TS (whose ComposeOptions.traceContext / ComposeTrace.traceContext this same
# `traceparent` header also drives), this Python port's compose_with_fixation / ComposeContext have no
# trace-context sink yet (see kohaku.host_core.trace_context's module docstring) — only HostErrorInfo's
# own failure-path observability field is covered here, mirroring kohaku.host_mcp's
# McpErrorInfo.trace_context.


def test_intent_normalize_trace_context_reaches_on_error(tmp_path: Path) -> None:
    captured: list[HostErrorInfo] = []

    def on_error(info: HostErrorInfo) -> None:
        captured.append(info)

    class RaisingSemantic(FakeSemantic):
        async def normalize(self, input: Any, ctx: Any) -> Any:
            raise RuntimeError("normalize failed (test)")

    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(catalog=catalog, semantic=RaisingSemantic(), storage=storage, llm=FakeLlm())
    deps = KohakuHostDeps(compose=ctx, domain=FakeDomain(), authz=FakeAuthz(), query_source="sales", on_error=on_error)
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)

    traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    res = client.post(
        _url("/intent/normalize"),
        json={"input": {"kind": "nl", "text": "Show me this quarter's sales summary"}},
        headers={"traceparent": traceparent, "tracestate": "vendor=value"},
    )
    assert res.status_code == 422
    assert len(captured) == 1
    assert captured[0].trace_context is not None
    assert captured[0].trace_context.traceparent == traceparent
    assert captured[0].trace_context.tracestate == "vendor=value"


def test_intent_normalize_malformed_traceparent_leaves_trace_context_none(tmp_path: Path) -> None:
    captured: list[HostErrorInfo] = []

    def on_error(info: HostErrorInfo) -> None:
        captured.append(info)

    class RaisingSemantic(FakeSemantic):
        async def normalize(self, input: Any, ctx: Any) -> Any:
            raise RuntimeError("normalize failed (test)")

    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(catalog=catalog, semantic=RaisingSemantic(), storage=storage, llm=FakeLlm())
    deps = KohakuHostDeps(compose=ctx, domain=FakeDomain(), authz=FakeAuthz(), query_source="sales", on_error=on_error)
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    client = TestClient(app)

    res = client.post(
        _url("/intent/normalize"),
        json={"input": {"kind": "nl", "text": "Show me this quarter's sales summary"}},
        headers={"traceparent": "not-a-w3c-traceparent"},
    )
    assert res.status_code == 422
    assert len(captured) == 1
    assert captured[0].trace_context is None

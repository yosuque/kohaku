"""POST /promotions/{id}/approve's `acknowledgedSuggestion` and the candidate's passed-through `suggestion`
(pytest port of the corresponding cases in packages/host-rest/test/promotions.test.ts).

The promotions API is a recording stub (host_rest discriminates structurally, not by importing lineage), so the
route's forwarding behavior is observed directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from kohaku.composer import ComposeContext
from kohaku.host_rest import KohakuHostDeps, attach_kohaku_routes
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import Principal
from kohaku.storage import FileStoragePort

from .conftest import PREFIX, FakeAuthz, FakeDomain, FakeSemantic

_DRAFT = {
    "componentType": "sales.customX",
    "version": "1.0.0",
    "intentName": "sales.customX",
    "description": "test draft",
}

_SUGGESTION = {
    "draft": {
        "componentType": "x.y",
        "version": "1.0.0",
        "intentName": "x.y",
        "description": "d",
    },
    "events": [],
    "confidence": 0.5,
    "model": "m",
    "extractorId": "l2-schema-extraction",
    "extractorVersion": "0.1",
    "suggestedAt": "2026-07-01T00:00:00.000Z",
}


@dataclass
class _Spy:
    approves: list[dict[str, Any]] = field(default_factory=list)


class _Promotions:
    """A configurable fake PromotionsApi. "known" is the only known artifact; unknown ones return None."""

    def __init__(self, spy: _Spy) -> None:
        self._spy = spy

    async def list_candidates(self, *, tenant: str | None = None) -> list[Any]:
        return []

    async def list_by_status(self, status: Any, *, tenant: str | None = None) -> list[Any]:
        return []

    async def get(self, artifact_id: str, tenant: str | None = None) -> Any:
        if artifact_id != "known":
            return None
        return {"artifactId": artifact_id, "status": "candidate", "suggestion": _SUGGESTION}

    async def evaluate_and_list(self, *, tenant: str | None = None) -> list[Any]:
        return []

    async def act(
        self, artifact_id: str, action: Any, actor: Principal, tenant: str | None = None
    ) -> Any:
        raise NotImplementedError

    async def approve(
        self,
        artifact_id: str,
        draft: Any,
        reviewer: Principal,
        tenant: str | None = None,
        *,
        acknowledged_suggestion: bool = False,
    ) -> Any:
        self._spy.approves.append(
            {
                "id": artifact_id,
                "reviewer": reviewer,
                "acknowledged_suggestion": acknowledged_suggestion,
            }
        )
        return {"artifactId": artifact_id, "status": "published"}

    async def reject(self, artifact_id: str, reviewer: Principal, tenant: str | None = None) -> Any:
        raise NotImplementedError

    async def withdraw(
        self,
        artifact_id: str,
        actor: Principal,
        reason: str | None = None,
        tenant: str | None = None,
    ) -> Any:
        raise NotImplementedError

    async def reconcile(self) -> Any:
        raise NotImplementedError


class _RawApprove(_Promotions):
    """Like _Promotions, but records whether the route passed the keyword at all."""

    async def approve(
        self,
        artifact_id: str,
        draft: Any,
        reviewer: Principal,
        tenant: str | None = None,
        **kwargs: Any,
    ) -> Any:
        self._spy.approves.append({"id": artifact_id, "kwargs": dict(kwargs)})
        return {"artifactId": artifact_id, "status": "published"}


def _client(tmp_path: Path, promotions: Any) -> TestClient:
    deps = KohakuHostDeps(
        compose=ComposeContext(
            catalog=resolve_catalog(core_catalog()),
            semantic=FakeSemantic(),
            storage=FileStoragePort(tmp_path),
            llm=FakeLlm(),
        ),
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        promotions=promotions,
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    return TestClient(app)


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def test_get_promotion_passes_the_candidates_suggestion_through_unchanged(tmp_path: Path) -> None:
    client = _client(tmp_path, _Promotions(_Spy()))
    res = client.get(_url("/promotions/known"))
    assert res.status_code == 200
    assert res.json()["candidate"]["suggestion"]["extractorId"] == "l2-schema-extraction"


def test_approve_forwards_an_optional_acknowledged_suggestion_absent_when_unspecified(
    tmp_path: Path,
) -> None:
    spy = _Spy()
    client = _client(tmp_path, _RawApprove(spy))

    ack = client.post(
        _url("/promotions/known/approve"), json={"draft": _DRAFT, "acknowledgedSuggestion": True}
    )
    assert ack.status_code == 200
    assert spy.approves[0]["kwargs"] == {"acknowledged_suggestion": True}

    no_ack = client.post(_url("/promotions/known/approve"), json={"draft": _DRAFT})
    assert no_ack.status_code == 200
    # Absent when the body does not carry it (the service then defaults it to False).
    assert spy.approves[1]["kwargs"] == {}

    explicit_false = client.post(
        _url("/promotions/known/approve"), json={"draft": _DRAFT, "acknowledgedSuggestion": False}
    )
    assert explicit_false.status_code == 200
    assert spy.approves[2]["kwargs"] == {"acknowledged_suggestion": False}


def test_approve_rejects_a_non_boolean_acknowledged_suggestion_with_400(tmp_path: Path) -> None:
    spy = _Spy()
    client = _client(tmp_path, _Promotions(spy))
    bad_values: list[Any] = ["yes", 1, None, {}]
    for bad in bad_values:
        res = client.post(
            _url("/promotions/known/approve"),
            json={"draft": _DRAFT, "acknowledgedSuggestion": bad},
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "BAD_REQUEST"
    assert spy.approves == []


def test_approve_with_a_known_stub_records_the_server_side_principal(tmp_path: Path) -> None:
    spy = _Spy()
    client = _client(tmp_path, _Promotions(spy))
    res = client.post(_url("/promotions/known/approve"), json={"draft": _DRAFT})
    assert res.status_code == 200
    assert res.json()["candidate"]["status"] == "published"
    assert spy.approves[0]["acknowledged_suggestion"] is False

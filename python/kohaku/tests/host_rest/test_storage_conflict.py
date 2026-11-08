"""409 CONFLICT for a storage compare-and-set conflict (port of packages/host-rest/test/storage-conflict.test.ts).

A StorageConflictError from a governance write (the StoragePort's optional compare-and-set lost a race with
another host instance) is answered with the contract's 409 CONFLICT and the fixed message -- never the error's
own text, never a 500, never retried inside the host.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kohaku.composer import ComposeContext
from kohaku.host_core import STORAGE_CONFLICT_MESSAGE
from kohaku.host_rest import HostErrorInfo, KohakuHostDeps, attach_kohaku_routes
from kohaku.lineage import create_fixations, create_lineage, create_promotions
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    Principal,
    StorageConflictError,
    UISpec,
)
from kohaku.storage import FileStoragePort, MemoryStoragePort

from ..lineage._helpers import l1_spec
from .conftest import PREFIX, FakeAuthz, FakeDomain, FakeSemantic

_DRAFT = {
    "componentType": "sales.customX",
    "version": "1.0.0",
    "intentName": "sales.customX",
    "description": "d",
}


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def _conflict() -> StorageConflictError:
    return StorageConflictError("promotion", "art-secret-key")


class _ConflictingPromotions:
    """A PromotionsApi stub whose every transition loses a compare-and-set race."""

    def __init__(self) -> None:
        self.approve_calls = 0

    async def list_candidates(self, *, tenant: str | None = None) -> list[Any]:
        return []

    async def list_by_status(self, status: Any, *, tenant: str | None = None) -> list[Any]:
        return []

    async def get(self, artifact_id: str, tenant: str | None = None) -> Any:
        return {"artifactId": artifact_id, "status": "candidate"}

    async def evaluate_and_list(self, *, tenant: str | None = None) -> list[Any]:
        return []

    async def act(
        self, artifact_id: str, action: Any, actor: Principal, tenant: str | None = None
    ) -> Any:
        raise _conflict()

    async def approve(
        self, artifact_id: str, draft: Any, reviewer: Principal, tenant: str | None = None
    ) -> Any:
        self.approve_calls += 1
        raise _conflict()

    async def reject(self, artifact_id: str, reviewer: Principal, tenant: str | None = None) -> Any:
        raise _conflict()

    async def withdraw(
        self,
        artifact_id: str,
        actor: Principal,
        reason: str | None = None,
        tenant: str | None = None,
    ) -> Any:
        raise _conflict()

    async def reconcile(self) -> Any:
        raise _conflict()


class _ConflictingFixations:
    async def proposals(self, *, tenant: str | None = None) -> Any:
        return []

    async def list_fixations(self, *, tenant: str | None = None) -> Any:
        return []

    async def fixate(
        self, *, pinned_spec: UISpec, approver: Principal, tenant: str | None = None
    ) -> Any:
        raise _conflict()

    async def unfixate(
        self, intent_hash: str, approver: Principal, tenant: str | None = None
    ) -> None:
        raise StorageConflictError("fixation", "intent-secret-hash")

    async def invalidate(self, *args: Any, **kwargs: Any) -> None:
        raise _conflict()

    async def refresh_fingerprint(self, *args: Any, **kwargs: Any) -> None:
        raise _conflict()


def _client(tmp_path: Path, **overrides: Any) -> tuple[TestClient, list[HostErrorInfo]]:
    reported: list[HostErrorInfo] = []
    ctx = ComposeContext(
        catalog=resolve_catalog(core_catalog()),
        semantic=FakeSemantic(),
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(),
    )
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        on_error=reported.append,
        **overrides,
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    return TestClient(app), reported


def _expect_conflict(res: Any) -> None:
    assert res.status_code == 409
    body = res.json()
    assert body["error"]["code"] == "CONFLICT"
    assert body["error"]["message"] == STORAGE_CONFLICT_MESSAGE
    assert isinstance(body["error"]["requestId"], str)
    # The error's own text (record kind + key) never reaches the client.
    assert "secret" not in res.text


def test_every_promotion_transition_route_answers_409_conflict_with_the_fixed_message(
    tmp_path: Path,
) -> None:
    client, reported = _client(tmp_path, promotions=_ConflictingPromotions())

    _expect_conflict(client.post(_url("/promotions/known/approve"), json={"draft": _DRAFT}))
    _expect_conflict(client.post(_url("/promotions/known/reject")))
    _expect_conflict(client.post(_url("/promotions/known/withdraw"), json={}))
    _expect_conflict(
        client.post(_url("/promotions/known/actions"), json={"action": {"kind": "judge.start"}})
    )

    # Reported to on_error under a dedicated endpoint (like the MCP profile), so conflicts can be measured;
    # the client message above stays fixed.
    assert [r.endpoint for r in reported] == ["storage.conflict"] * 4
    assert all(isinstance(r.error, StorageConflictError) for r in reported)


def test_the_fixation_removal_route_answers_409_conflict_with_the_fixed_message(
    tmp_path: Path,
) -> None:
    client, reported = _client(tmp_path, fixations=_ConflictingFixations())

    _expect_conflict(client.post(_url("/fixations/sha256:abc/remove")))

    assert [r.endpoint for r in reported] == ["storage.conflict"]


def test_a_conflict_is_not_retried_inside_the_host(tmp_path: Path) -> None:
    promotions = _ConflictingPromotions()
    client, _ = _client(tmp_path, promotions=promotions)

    _expect_conflict(client.post(_url("/promotions/known/approve"), json={"draft": _DRAFT}))

    assert promotions.approve_calls == 1


def test_an_unrelated_failure_is_still_a_500_internal_with_a_fixed_message(tmp_path: Path) -> None:
    class _Broken(_ConflictingPromotions):
        async def approve(
            self, artifact_id: str, draft: Any, reviewer: Principal, tenant: str | None = None
        ) -> Any:
            raise RuntimeError("db password is hunter2")

    client, reported = _client(tmp_path, promotions=_Broken())

    res = client.post(_url("/promotions/known/approve"), json={"draft": _DRAFT})

    assert res.status_code == 500
    assert res.json()["error"]["code"] == "INTERNAL"
    assert "hunter2" not in res.text
    assert len(reported) == 1


# --- Real concurrency: two host instances (two apps, two lineage/promotion services, two lock owners) over
# ONE compare-and-set storage, the shape a shared redis / postgres has. The in-process lock cannot order calls
# across the two apps, so only the storage's compare-and-set can make one of them lose.


def _two_instances(storage: MemoryStoragePort) -> list[FastAPI]:
    apps = []
    for _ in range(2):
        ctx = ComposeContext(
            catalog=resolve_catalog(core_catalog()),
            semantic=FakeSemantic(),
            storage=storage,
            llm=FakeLlm(),
        )
        deps = KohakuHostDeps(
            compose=ctx,
            domain=FakeDomain(),
            authz=FakeAuthz(),
            query_source="sales",
            promotions=create_promotions(lineage=create_lineage(storage), storage=storage),
            fixations=create_fixations(lineage=create_lineage(storage), storage=storage),
        )
        app = FastAPI()
        attach_kohaku_routes(app, deps)
        apps.append(app)
    return apps


async def _post_both(apps: list[FastAPI], path: str, body: Any = None) -> list[httpx.Response]:
    async def one(app: FastAPI) -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            return await client.post(_url(path), json=body)

    return list(await asyncio.gather(*(one(a) for a in apps)))


def test_two_concurrent_promotion_transitions_exactly_one_succeeds_the_other_is_409() -> None:
    async def run() -> None:
        storage = MemoryStoragePort()
        await storage.append_lineage(
            LineageEventRecord(
                id="g-1",
                ts="2026-07-17T00:00:00.000Z",
                actor=LineageActor(kind="model"),
                type="component.generated",
                payload={"artifactId": "art-1", "html": "<html></html>", "request": "r"},
            )
        )
        responses = await _post_both(
            _two_instances(storage), "/promotions/art-1/actions", {"action": {"kind": "nominate"}}
        )

        assert sorted(r.status_code for r in responses) == [200, 409]
        _expect_conflict(next(r for r in responses if r.status_code == 409))
        state = await storage.get_promotion_state("art-1")
        assert state is not None and state.status == "candidate"

    asyncio.run(run())


def test_two_concurrent_fixation_removals_exactly_one_succeeds_the_other_is_409() -> None:
    async def run() -> None:
        storage = MemoryStoragePort()
        spec: UISpec = l1_spec()
        await storage.put_fixation(
            FixationRecord(
                intentHash=spec.intent.hash,
                canonical="sales.trend",
                structureHash="sha256:" + "1" * 64,
                pinnedSpec=spec,
                fixatedAt="2026-07-01T00:00:00Z",
                approver=Principal(id="tester"),
                revision="r1",
            )
        )
        responses = await _post_both(
            _two_instances(storage), f"/fixations/{spec.intent.hash}/remove"
        )

        assert sorted(r.status_code for r in responses) == [200, 409]
        _expect_conflict(next(r for r in responses if r.status_code == 409))
        assert await storage.get_fixation(spec.intent.hash) is None
        unfixated = [e for e in await storage.list_lineage() if e.type == "intent.unfixated"]
        assert len(unfixated) == 1

    asyncio.run(run())

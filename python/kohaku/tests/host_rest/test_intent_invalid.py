"""A directly-specified Intent (kind: "intent") must be rejected with 422 INTENT_INVALID -- and leave no
trace in the cache, lineage, or fixation store -- when the wired SemanticPort implements validate_intent and
rejects it. Covers every REST entry point that funnels a directly-specified Intent through host-core's
resolve_intent: POST /compose, POST /events (the pre-event `current`), and POST /fixations/approve. Port of
packages/host-rest/test/intent-invalid.test.ts.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from kohaku.composer import ComposeContext
from kohaku.host_rest import KohakuHostDeps, attach_kohaku_routes
from kohaku.lineage import create_fixations, create_lineage, create_view_recorder
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    DataShape,
    GuiAction,
    Intent,
    IntentInput,
    IntentValidationError,
    IntentValidationIssue,
    LineageFilter,
    QueryHandle,
    SemanticInput,
    SessionContext,
)
from kohaku.storage import FileStoragePort

from .conftest import PREFIX, REF, FakeAuthz, FakeDomain, _l1_draft


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


class ValidatingSemantic:
    """Only "sales.trend" with metric in {revenue, units} validates; everything else is rejected."""

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        if isinstance(input, GuiAction):
            base = dict(input.current.params) if input.current is not None else {}
            return IntentInput(canonical="sales.trend", params={**base, **input.params})
        return IntentInput(canonical="sales.trend", params={})

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return QueryHandle(uri=REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@v1"

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        return None

    async def validate_intent(self, intent: IntentInput, ctx: SessionContext) -> IntentInput:
        if intent.canonical != "sales.trend":
            raise IntentValidationError(f'unknown intent "{intent.canonical}"')
        metric = intent.params.get("metric", "revenue")
        if metric not in ("revenue", "units"):
            message = 'param "metric": expected one of revenue, units'
            raise IntentValidationError(message, [IntentValidationIssue(path="metric", message=message)])
        return IntentInput(canonical=intent.canonical, params={**intent.params, "metric": metric})


def _build(tmp_path: Path) -> tuple[TestClient, FileStoragePort]:
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(
        catalog=catalog,
        semantic=ValidatingSemantic(),
        storage=storage,
        llm=FakeLlm(objects=lambda _req: _l1_draft()),
    )
    lineage = create_lineage(storage)
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        recorder=create_view_recorder(lineage),
        fixations=create_fixations(lineage=lineage, storage=storage, catalog_for=lambda _t: catalog),
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    return TestClient(app), storage


def _composed_count(storage: FileStoragePort) -> int:
    return len(asyncio.run(storage.list_lineage(LineageFilter(type=["view.composed"]))))


def _interacted_count(storage: FileStoragePort) -> int:
    return len(asyncio.run(storage.list_lineage(LineageFilter(type=["view.interacted"]))))


class TestComposeRejectsAnInvalidDirectlySpecifiedIntent:
    def test_an_unknown_canonical_is_422_intent_invalid_and_nothing_is_cached_or_recorded(
        self, tmp_path: Path
    ) -> None:
        client, storage = _build(tmp_path)
        res = client.post(_url("/compose"), json={"intent": {"canonical": "sales.bogus", "params": {}}})
        assert res.status_code == 422
        body: dict[str, Any] = res.json()
        assert body["error"]["code"] == "INTENT_INVALID"
        assert 'unknown intent "sales.bogus"' in body["error"]["message"]
        assert _composed_count(storage) == 0

    def test_an_invalid_param_value_is_422_intent_invalid_and_nothing_is_cached_or_recorded(
        self, tmp_path: Path
    ) -> None:
        client, storage = _build(tmp_path)
        res = client.post(
            _url("/compose"),
            json={"intent": {"canonical": "sales.trend", "params": {"metric": "bogus"}}},
        )
        assert res.status_code == 422
        body: dict[str, Any] = res.json()
        assert body["error"]["code"] == "INTENT_INVALID"
        assert "metric" in body["error"]["message"]
        assert _composed_count(storage) == 0

    def test_a_valid_directly_specified_intent_still_composes_normally(self, tmp_path: Path) -> None:
        client, _storage = _build(tmp_path)
        res = client.post(
            _url("/compose"),
            json={"intent": {"canonical": "sales.trend", "params": {"metric": "units"}}},
        )
        assert res.status_code == 200


class TestEventsRejectsAnInvalidCurrentIntent:
    def test_an_invalid_current_intent_is_422_and_interacted_composed_are_never_recorded(
        self, tmp_path: Path
    ) -> None:
        client, storage = _build(tmp_path)
        res = client.post(
            _url("/events"),
            json={
                "intent": {"canonical": "sales.trend", "params": {"metric": "bogus"}},
                "event": {"on": "table1.sort", "payload": {}},
            },
        )
        assert res.status_code == 422
        body: dict[str, Any] = res.json()
        assert body["error"]["code"] == "INTENT_INVALID"
        assert _interacted_count(storage) == 0
        assert _composed_count(storage) == 0


class TestFixationsApproveRejectsAnInvalidIntent:
    def test_an_invalid_intent_is_422_and_the_fixation_is_never_written(self, tmp_path: Path) -> None:
        client, storage = _build(tmp_path)
        res = client.post(
            _url("/fixations/approve"), json={"intent": {"canonical": "sales.bogus", "params": {}}}
        )
        assert res.status_code == 422
        body: dict[str, Any] = res.json()
        assert body["error"]["code"] == "INTENT_INVALID"
        assert asyncio.run(storage.list_fixations()) == []
        assert _composed_count(storage) == 0

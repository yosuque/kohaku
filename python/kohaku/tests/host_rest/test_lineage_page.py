"""GET /lineage?order=asc&cursor=&pageSize= (design.md #53). Port of
packages/host-rest/test/lineage-page.test.ts. The pre-existing (order-less) behavior is covered by
test_routes.py and is untouched here.
"""

from __future__ import annotations

import asyncio
import dataclasses
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from kohaku.host_rest import attach_kohaku_routes
from kohaku.spec import LineageActor, LineageEventRecord

from .conftest import PREFIX, Harness, build_harness


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def _event(event_id: str, ts: str, **payload: Any) -> LineageEventRecord:
    return LineageEventRecord(
        id=event_id, ts=ts, actor=LineageActor(kind="system"), type="view.composed", payload=payload
    )


def _seed(harness: Harness, *events: LineageEventRecord) -> None:
    async def run() -> None:
        for event in events:
            await harness.storage.append_lineage(event)

    asyncio.run(run())


def test_pages_forward_in_ascending_order(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed(harness, *(_event(f"e{i}", f"2026-01-0{i + 1}T00:00:00.000Z") for i in range(5)))

    res1 = harness.client.get(_url("/lineage"), params={"order": "asc", "pageSize": 2})
    assert res1.status_code == 200
    body1 = res1.json()
    assert [e["id"] for e in body1["events"]] == ["e0", "e1"]
    assert body1.get("nextCursor") is not None

    res2 = harness.client.get(
        _url("/lineage"), params={"order": "asc", "pageSize": 2, "cursor": body1["nextCursor"]}
    )
    body2 = res2.json()
    assert [e["id"] for e in body2["events"]] == ["e2", "e3"]
    assert body2.get("nextCursor") is not None

    res3 = harness.client.get(
        _url("/lineage"), params={"order": "asc", "pageSize": 2, "cursor": body2["nextCursor"]}
    )
    body3 = res3.json()
    assert [e["id"] for e in body3["events"]] == ["e4"]
    assert "nextCursor" not in body3


def test_default_order_less_response_shape_is_unchanged(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed(harness, _event("e0", "2026-01-01T00:00:00.000Z"))
    res = harness.client.get(_url("/lineage"))
    assert set(res.json().keys()) == {"events"}


def test_combines_order_asc_with_correlation_id(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed(
        harness,
        _event("e0", "2026-01-01T00:00:00.000Z", correlationId="c1"),
        _event("e1", "2026-01-02T00:00:00.000Z", correlationId="other"),
        _event("e2", "2026-01-03T00:00:00.000Z", correlationId="c1"),
    )
    res = harness.client.get(_url("/lineage"), params={"order": "asc", "correlationId": "c1"})
    assert [e["id"] for e in res.json()["events"]] == ["e0", "e2"]


def test_default_order_less_also_honours_correlation_id(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed(
        harness,
        _event("e0", "2026-01-01T00:00:00.000Z", correlationId="c1"),
        _event("e1", "2026-01-02T00:00:00.000Z", correlationId="other"),
    )
    res = harness.client.get(_url("/lineage"), params={"correlationId": "c1"})
    assert [e["id"] for e in res.json()["events"]] == ["e0"]


def test_bad_request_for_an_order_value_other_than_asc(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    res = harness.client.get(_url("/lineage"), params={"order": "desc"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_bad_request_for_a_malformed_cursor(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed(harness, _event("e0", "2026-01-01T00:00:00.000Z"))
    res = harness.client.get(_url("/lineage"), params={"order": "asc", "cursor": "not-a-real-cursor"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"


class _NoPageLineageStorage:
    """Forwards every StoragePort call to `inner` except `page_lineage` (hasattr(..., "page_lineage") is
    False) -- simulates a backend that has not implemented the optional forward-paging extension."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        if name == "page_lineage":
            raise AttributeError(name)
        return getattr(self._inner, name)


def test_not_implemented_when_storage_has_no_page_lineage(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    wrapped_ctx = dataclasses.replace(harness.ctx, storage=_NoPageLineageStorage(harness.storage))
    wrapped_deps = dataclasses.replace(harness.deps, compose=wrapped_ctx)
    app = FastAPI()
    attach_kohaku_routes(app, wrapped_deps)
    client = TestClient(app)

    res = client.get(_url("/lineage"), params={"order": "asc"})
    assert res.status_code == 501
    assert res.json()["error"]["code"] == "NOT_IMPLEMENTED"

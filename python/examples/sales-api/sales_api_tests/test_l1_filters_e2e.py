"""e2e for L1 filter injection in the Python sample (port of TS apps/sample-api/test/l1-filters.e2e.test.ts).

ComposePolicy.l1Filters is on in the sample: a screen the (scripted) model generated for sales.trend
(region=japan) gains control.select + data.bind for the Intent's region facet, and the capability issued for it
re-resolves every variant WITHOUT another composition (the LLM is called exactly once). metric / granularity /
groupBy are declared `filterable=False` in the sample catalog -- they rename the result's columns, which the
chart's x / y props would not follow -- so they are never injected filters.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi.testclient import TestClient

from kohaku.authz_hmac import create_hmac_authz_port
from kohaku.llm import FakeLlm
from kohaku.storage import MemoryStoragePort
from sales_api.app import create_app

TREND_REF = "query://sales/trend?granularity=month&metric=revenue&region=japan"
REGIONS = ("japan", "north_america", "europe", "apac")
TREND_INTENT = {"canonical": "sales.trend", "params": {"region": "japan"}}


def _trend_draft() -> dict[str, Any]:
    return {
        "components": [
            {"id": "root", "type": "layout.stack", "props": {}, "children": ["h", "c"]},
            {
                "id": "h",
                "type": "text.heading",
                "props": {"level": 2, "text": "Monthly revenue trend"},
            },
            {
                "id": "c",
                "type": "presentChart",
                "props": {"kind": "line", "x": "month", "y": "revenue"},
                "data": {"$ref": TREND_REF},
            },
        ],
        "events": [],
    }


def _make() -> tuple[TestClient, FakeLlm]:
    llm = FakeLlm(objects=[_trend_draft(), _trend_draft()])
    app = asyncio.run(
        create_app(
            llm=llm, storage=MemoryStoragePort(), authz=create_hmac_authz_port("test-secret")
        )
    )
    return TestClient(app.app), llm


def _resolve(client: TestClient, capability: str, ref: str) -> tuple[int, Any]:
    res = client.get(
        "/api/kohaku/binding/resolve",
        params={"ref": ref},
        headers={"authorization": f"Bearer {capability}"},
    )
    return res.status_code, (res.json() if res.status_code == 200 else None)


def _resolve_status(client: TestClient, capability: str, ref: str) -> int:
    return _resolve(client, capability, ref)[0]


def test_compose_injects_the_shape_stable_facet_filters_and_the_capability_resolves_every_variant() -> (
    None
):
    client, llm = _make()
    res = client.post("/api/kohaku/compose", json={"intent": TREND_INTENT})
    assert res.status_code == 200
    body = res.json()
    spec, capability = body["spec"], body["capability"]
    assert spec["provenance"]["tier"] == "L1"
    assert len(llm.calls) == 1

    # Only region is injected: metric / granularity are filterable=False (they rename the result's columns).
    assert spec["state"] == {"region": "japan"}
    controls = [c for c in spec["components"] if c["type"] == "control.select"]
    assert [c["id"] for c in controls] == ["filter-region"]
    chart = next(c for c in spec["components"] if c["type"] == "presentChart")
    assert chart["data"]["$ref"] == TREND_REF
    assert list(chart["data"]["bind"].keys()) == ["region"]

    # Changing the filter = resolving another variant of the same screen: 200 for every authorized value, and
    # the chart's x / y props still name columns of the returned rows (a switched filter never blanks the chart).
    x, y = chart["props"]["x"], chart["props"]["y"]
    for region in REGIONS:
        ref = f"query://sales/trend?granularity=month&metric=revenue&region={region}"
        status, data = _resolve(client, capability, ref)
        assert status == 200
        assert len(data["rows"]) > 0
        for row in data["rows"]:
            assert x in row and y in row
    # ...403 for a value outside the declared domain (no forgery), 403 for the shape-changing variants that are
    # NOT filters any more (the capability signs no scope for them), and still exactly one generation.
    for forged in (
        "query://sales/trend?granularity=month&metric=revenue&region=bogus",
        "query://sales/trend?granularity=month&metric=units&region=japan",
        "query://sales/trend?granularity=quarter&metric=revenue&region=japan",
    ):
        assert _resolve_status(client, capability, forged) == 403
    assert len(llm.calls) == 1


def test_compose_stream_final_patch_capability_covers_the_filter_variants() -> None:
    client, llm = _make()
    res = client.post("/api/kohaku/compose/stream", json={"intent": TREND_INTENT})
    assert res.status_code == 200
    events: list[tuple[str, dict[str, Any]]] = []
    for block in res.text.split("\n\n"):
        lines = block.split("\n")
        event = next((ln[len("event:") :].strip() for ln in lines if ln.startswith("event:")), None)
        data = next((ln[len("data:") :].strip() for ln in lines if ln.startswith("data:")), None)
        if event is not None and data is not None:
            events.append((event, json.loads(data)))
    skeleton_cap = next(d for e, d in events if e == "spec")["capability"]
    final_cap = [d for e, d in events if e == "patch"][-1]["capability"]
    assert isinstance(final_cap, str)

    variant = "query://sales/trend?granularity=month&metric=revenue&region=europe"
    assert _resolve_status(client, skeleton_cap, variant) == 403
    assert _resolve_status(client, final_cap, variant) == 200
    assert len(llm.calls) == 1


def test_a_japanese_session_gets_japanese_filter_labels_and_is_cached_separately() -> None:
    client, _ = _make()

    def labels(locale: str) -> dict[str, object]:
        res = client.post(
            "/api/kohaku/compose",
            json={
                "intent": TREND_INTENT,
                "session": {"surface": "web", "locale": locale},
            },
        )
        assert res.status_code == 200
        return {
            c["id"]: c["props"]["label"]
            for c in res.json()["spec"]["components"]
            if c["type"] == "control.select"
        }

    assert labels("ja") == {"filter-region": "地域"}
    assert labels("en") == {"filter-region": "Region"}

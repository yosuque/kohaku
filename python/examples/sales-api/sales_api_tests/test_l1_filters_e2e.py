"""e2e for L1 filter injection in the Python sample (port of TS apps/sample-api/test/l1-filters.e2e.test.ts).

ComposePolicy.l1Filters is on in the sample: a screen the (scripted) model generated for sales.trend gains
control.select + data.bind for the Intent's metric / granularity facets, and the capability issued for it
re-resolves every variant WITHOUT another composition (the LLM is called exactly once).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi.testclient import TestClient

from kohaku.llm import FakeLlm
from kohaku.storage import MemoryStoragePort
from sales_api.app import create_app
from sales_api.authz_port import create_hmac_authz_port

TREND_REF = "query://sales/trend?granularity=month&metric=revenue"


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


def _resolve_status(client: TestClient, capability: str, ref: str) -> int:
    res = client.get(
        "/api/kohaku/binding/resolve",
        params={"ref": ref},
        headers={"authorization": f"Bearer {capability}"},
    )
    return res.status_code


def test_compose_injects_the_facet_filters_and_the_capability_resolves_every_variant() -> None:
    client, llm = _make()
    res = client.post(
        "/api/kohaku/compose", json={"intent": {"canonical": "sales.trend", "params": {}}}
    )
    assert res.status_code == 200
    body = res.json()
    spec, capability = body["spec"], body["capability"]
    assert spec["provenance"]["tier"] == "L1"
    assert len(llm.calls) == 1

    # metric and granularity are in the ref and declared as vocabulary facets; region / productId are not in the ref.
    assert spec["state"] == {"granularity": "month", "metric": "revenue"}
    controls = [c for c in spec["components"] if c["type"] == "control.select"]
    assert sorted(c["id"] for c in controls) == ["filter-granularity", "filter-metric"]
    chart = next(c for c in spec["components"] if c["type"] == "presentChart")
    assert chart["data"]["$ref"] == TREND_REF
    assert sorted(chart["data"]["bind"].keys()) == ["granularity", "metric"]

    # Changing a filter = resolving another variant of the same screen: 200 for every authorized value...
    for metric in ("revenue", "units"):
        for granularity in ("month", "quarter"):
            ref = f"query://sales/trend?granularity={granularity}&metric={metric}"
            assert _resolve_status(client, capability, ref) == 200
    # ...403 for a value outside the declared domain (no forgery), and still exactly one generation.
    assert (
        _resolve_status(client, capability, "query://sales/trend?granularity=month&metric=bogus")
        == 403
    )
    assert len(llm.calls) == 1


def test_compose_stream_final_patch_capability_covers_the_filter_variants() -> None:
    client, llm = _make()
    res = client.post(
        "/api/kohaku/compose/stream", json={"intent": {"canonical": "sales.trend", "params": {}}}
    )
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

    variant = "query://sales/trend?granularity=quarter&metric=units"
    assert _resolve_status(client, skeleton_cap, variant) == 403
    assert _resolve_status(client, final_cap, variant) == 200
    assert len(llm.calls) == 1


def test_a_japanese_session_gets_japanese_filter_labels_and_is_cached_separately() -> None:
    client, _ = _make()

    def labels(locale: str) -> dict[str, object]:
        res = client.post(
            "/api/kohaku/compose",
            json={
                "intent": {"canonical": "sales.trend", "params": {}},
                "session": {"surface": "web", "locale": locale},
            },
        )
        assert res.status_code == 200
        return {
            c["id"]: c["props"]["label"]
            for c in res.json()["spec"]["components"]
            if c["type"] == "control.select"
        }

    assert labels("ja") == {"filter-granularity": "粒度", "filter-metric": "指標"}
    assert labels("en") == {"filter-granularity": "Granularity", "filter-metric": "Metric"}

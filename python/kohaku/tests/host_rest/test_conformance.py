"""pytest-ification of the REST profile conformance (spec/conformance/rest-host.ts).

Verifies each REST-* / LIN-PRM-001 check item ahead of time with a FastAPI TestClient. Guarantees that the wire
shape, status codes, and error envelope match the TS reference implementation.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from kohaku.lineage import now_iso
from kohaku.spec import (
    LineageActor,
    LineageEventRecord,
    apply_patch,
    canonical_stringify,
    parse_patch,
    parse_spec,
)

from .conftest import INTENT_BODY, PREFIX, Harness, build_harness

_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def _is_error_envelope(payload: Any) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("error"), dict)
        and payload["error"].get("code") is not None
        and payload["error"].get("message") is not None
    )


# --- REST-INT-001 -----------------------------------------------------------


def test_rest_int_001(client: TestClient) -> None:
    res = client.post(
        _url("/intent/normalize"),
        json={
            "input": {
                "kind": "gui",
                "action": "view.select",
                "params": {"intent": INTENT_BODY["canonical"], **INTENT_BODY["params"]},
            }
        },
    )
    assert res.status_code == 200
    intent = res.json()["intent"]
    assert _HASH_RE.match(intent["hash"])
    assert res.json()["source"] == "deterministic"


# --- REST-CMP-001 / 002 -----------------------------------------------------


def test_rest_cmp_001_spec_and_capability(client: TestClient) -> None:
    res = client.post(_url("/compose"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    body = res.json()
    parse_spec(body["spec"])  # §2 conformance (raises if non-conformant)
    assert isinstance(body["capability"], str) and len(body["capability"]) > 0


def test_rest_cmp_002_cache_hit_and_determinism(client: TestClient) -> None:
    first = client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    second = client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    assert second["provenance"]["cache"] in ("hit", "fixated")
    assert second["components"] == first["components"]


# --- REST-BND-001 / 002 -----------------------------------------------------


def _first_ref(spec: dict[str, Any]) -> str | None:
    for c in spec["components"]:
        data = c.get("data")
        if data is not None and data.get("$ref") is not None:
            ref: str = data["$ref"]
            return ref
    return None


def test_rest_bnd_001_requires_capability(client: TestClient) -> None:
    spec = client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    ref = _first_ref(spec)
    assert ref is not None
    res = client.get(_url("/binding/resolve"), params={"ref": ref})
    assert res.status_code == 401
    assert _is_error_envelope(res.json())


def test_rest_bnd_002_returns_tabular_envelope(client: TestClient) -> None:
    body = client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()
    spec, capability = body["spec"], body["capability"]
    ref = _first_ref(spec)
    assert ref is not None
    res = client.get(
        _url("/binding/resolve"),
        params={"ref": ref},
        headers={"authorization": f"Bearer {capability}"},
    )
    assert res.status_code == 200
    data = res.json()
    assert isinstance(data["columns"], list) and isinstance(data["rows"], list)
    expected = (spec.get("refVersions") or {}).get(ref, spec["dataVersion"])
    assert data["dataVersion"] == expected


# --- REST-CAT-001 -----------------------------------------------------------


def test_rest_cat_001_catalog(client: TestClient) -> None:
    res = client.get(_url("/catalog"))
    assert res.status_code == 200
    body = res.json()
    assert body.get("catalogVersion")
    components = body["components"]
    assert len(components) > 0
    assert all(
        c.get("type") is not None
        and c.get("version") is not None
        and c.get("propsSchema") is not None
        for c in components
    )


# --- REST-EVT-001 -----------------------------------------------------------


def test_rest_evt_001_events_recompose(client: TestClient) -> None:
    spec = client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    event = spec["events"][0]
    res = client.post(
        _url("/events"),
        json={
            "intent": {"canonical": spec["intent"]["canonical"], "params": spec["intent"]["params"]},
            "event": {"on": event["on"], "payload": {}},
        },
    )
    assert res.status_code == 200
    parse_spec(res.json()["spec"])


# --- REST-ERR-001 -----------------------------------------------------------


def test_rest_err_001_bad_request_envelope(client: TestClient) -> None:
    non_json = client.post(
        _url("/compose"),
        content="this is not JSON",
        headers={"content-type": "application/json"},
    )
    assert non_json.status_code == 400
    assert _is_error_envelope(non_json.json())

    empty = client.post(_url("/compose"), json={"session": {"surface": "web"}})
    assert empty.status_code == 400
    assert _is_error_envelope(empty.json())


# --- REST-ERR-002 -----------------------------------------------------------


def test_rest_err_002_governance_get_shapes(client: TestClient) -> None:
    promotions = client.get(_url("/promotions"))
    assert promotions.status_code == 200
    assert isinstance(promotions.json()["candidates"], list)

    fixations = client.get(_url("/fixations"))
    assert fixations.status_code == 200
    assert isinstance(fixations.json()["fixations"], list)


def test_rest_err_002_not_implemented_when_unconfigured(tmp_path: Path) -> None:
    harness = build_harness(tmp_path, with_promotions=False, with_fixations=False)
    promotions = harness.client.get(_url("/promotions"))
    assert promotions.status_code == 501
    assert promotions.json()["error"]["code"] == "NOT_IMPLEMENTED"
    fixations = harness.client.get(_url("/fixations"))
    assert fixations.status_code == 501
    assert fixations.json()["error"]["code"] == "NOT_IMPLEMENTED"


# --- REST-LIN-001 -----------------------------------------------------------


def test_rest_lin_001_lineage_limit(client: TestClient) -> None:
    # Push at least one event onto the audit plane (compose's view.composed).
    client.post(_url("/compose"), json={"intent": INTENT_BODY})
    res = client.get(_url("/lineage"), params={"limit": 1})
    assert res.status_code == 200
    events = res.json()["events"]
    assert isinstance(events, list)
    assert len(events) <= 1


# --- REST-GOV-001 -----------------------------------------------------------


def test_rest_gov_001_bad_payload_and_unknown_artifact(client: TestClient) -> None:
    bad = client.post(
        _url("/promotions/unknown-artifact/actions"), json={"action": {"kind": "not-a-real-kind"}}
    )
    assert bad.status_code == 400

    missing = client.post(
        _url("/promotions/nonexistent-artifact-id/actions"), json={"action": {"kind": "nominate"}}
    )
    assert missing.status_code == 404


# --- LIN-PRM-001 (a human approve precedes publish in time) -----------------


def _seed_generated(harness: Harness, artifact_id: str) -> None:
    """Push one component.generated event (the material for a promotion candidate)."""
    event = LineageEventRecord(
        id=f"gen-{artifact_id}",
        ts=now_iso(),
        actor=LineageActor(kind="model", model="fake"),
        type="component.generated",
        payload={
            "artifactId": artifact_id,
            "canonical": "sales.custom",
            "request": "Custom sales view",
            "html": "<!DOCTYPE html><html><body>art</body></html>",
            "artifactSha256": "sha256:" + "0" * 64,
            "ref": harness.ref,
        },
    )
    asyncio.run(harness.storage.append_lineage(event))


def test_lin_prm_001_publish_preceded_by_human_approve(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    _seed_generated(harness, "art-1")
    draft = {
        "componentType": "sales.customView",
        "version": "1.0.0",
        "intentName": "sales.custom",
        "description": "Custom sales view",
    }
    res = harness.client.post(_url("/promotions/art-1/approve"), json={"draft": draft})
    assert res.status_code == 200, res.text
    assert res.json()["candidate"]["status"] == "published"

    lineage = harness.client.get(_url("/lineage"), params={"limit": 1000}).json()["events"]
    published = [e for e in lineage if e["type"] == "component.published"]
    assert len(published) >= 1
    for pub in published:
        artifact_id = pub["payload"]["artifactId"]
        approve = next(
            (
                e
                for e in lineage
                if e["type"] == "component.reviewed"
                and e["payload"].get("artifactId") == artifact_id
                and e["payload"].get("decision") == "approve"
                and e["actor"].get("kind") == "user"
            ),
            None,
        )
        assert approve is not None
        assert approve["ts"] <= pub["ts"]


# --- REST-STR-001..003 (SSE streaming) --------------------------------------


def _read_sse(text: str) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []
    event = ""
    data_lines: list[str] = []

    def flush() -> None:
        nonlocal event, data_lines
        if event != "" or data_lines:
            events.append({"event": event, "data": "\n".join(data_lines)})
            event = ""
            data_lines = []

    for raw in text.split("\n"):
        line = raw[:-1] if raw.endswith("\r") else raw
        if line == "":
            flush()
            continue
        if line.startswith(":"):
            continue
        idx = line.find(":")
        field = line if idx == -1 else line[:idx]
        value = "" if idx == -1 else line[idx + 1 :]
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
    flush()
    return events


def _stream(client: TestClient) -> list[dict[str, str]]:
    res = client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    return _read_sse(res.text)


def test_rest_str_001_first_event_is_spec(client: TestClient) -> None:
    import json

    events = _stream(client)
    first = events[0]
    assert first["event"] == "spec"
    payload = json.loads(first["data"])
    parse_spec(payload["spec"])
    assert isinstance(payload["final"], bool)
    assert isinstance(payload["capability"], str) and len(payload["capability"]) > 0


def test_rest_str_002_patch_equivalence(client: TestClient) -> None:
    import json

    events = _stream(client)
    first = next(e for e in events if e["event"] == "spec")
    streamed = parse_spec(json.loads(first["data"])["spec"])
    for ev in (e for e in events if e["event"] == "patch"):
        patch = parse_patch(json.loads(ev["data"])["patch"])
        streamed = apply_patch(streamed, patch)
    non_stream = parse_spec(
        client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    )
    assert canonical_stringify(
        [c.to_wire() for c in streamed.components]
    ) == canonical_stringify([c.to_wire() for c in non_stream.components])
    assert canonical_stringify(
        [e.to_wire() for e in streamed.events]
    ) == canonical_stringify([e.to_wire() for e in non_stream.events])


def test_rest_str_003_single_terminator(client: TestClient) -> None:
    events = _stream(client)
    terminators = [e for e in events if e["event"] in ("done", "error")]
    assert len(terminators) == 1
    assert events[-1]["event"] == terminators[0]["event"]

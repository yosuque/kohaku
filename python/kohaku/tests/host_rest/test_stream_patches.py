"""Black-box check that /compose/stream's SSE can forward "multiple provisional patches" (an extension of REST-STR-002).

conftest's shared harness (FakeLlm objects=lambda ...) has no partials, so it is only "skeleton -> final patch" with
no provisional patches. Here it is swapped for a FakeLlm with partials, and verifies that the sequential-streaming
provisional patches (1..N) + the final patch arrive as multiple SSE `event: patch`, and that the apply_patch fold in
receive order matches the non-stream /compose (equivalence).
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from kohaku.llm import FakeLlm
from kohaku.spec import apply_patch, canonical_stringify, parse_patch, parse_spec

from .conftest import INTENT_BODY, PREFIX, Harness, _l1_draft, build_harness


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


def _partials() -> list[Any]:
    """The cumulative partial sequence of _l1_draft (wire form of the generation draft)."""
    comps = _l1_draft()["components"]  # [root, heading, spreadsheet]
    return [
        {"components": [comps[0]], "events": []},
        {"components": [comps[0], comps[1]], "events": []},
        {"components": [comps[0], comps[1], comps[2]], "events": []},
    ]


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


def _partials_harness(tmp_path: Path) -> Harness:
    harness = build_harness(tmp_path)
    # Swap compose ctx for a FakeLlm with partials (deps is a mutable dataclass, so it takes effect in the existing app).
    harness.deps.compose = replace(
        harness.ctx, llm=FakeLlm(objects=[_l1_draft()], partials=[_partials()])
    )
    return harness


def test_stream_forwards_multiple_patches(tmp_path: Path) -> None:
    harness = _partials_harness(tmp_path)
    client: TestClient = harness.client

    res = client.post(_url("/compose/stream"), json={"intent": INTENT_BODY})
    assert res.status_code == 200
    events = _read_sse(res.text)

    # Leading spec (skeleton) + multiple patches (>=1 provisional + 1 final) + a single done.
    assert events[0]["event"] == "spec"
    patch_events = [e for e in events if e["event"] == "patch"]
    assert len(patch_events) >= 2
    terminators = [e for e in events if e["event"] in ("done", "error")]
    assert len(terminators) == 1 and events[-1]["event"] == "done"

    # REST-STR-002: the apply_patch fold in receive order matches the non-stream /compose in components/events.
    streamed = parse_spec(json.loads(events[0]["data"])["spec"])
    for ev in patch_events:
        streamed = apply_patch(streamed, parse_patch(json.loads(ev["data"])["patch"]))

    non_stream = parse_spec(
        client.post(_url("/compose"), json={"intent": INTENT_BODY}).json()["spec"]
    )
    assert canonical_stringify([c.to_wire() for c in streamed.components]) == canonical_stringify(
        [c.to_wire() for c in non_stream.components]
    )
    assert canonical_stringify([e.to_wire() for e in streamed.events]) == canonical_stringify(
        [e.to_wire() for e in non_stream.events]
    )

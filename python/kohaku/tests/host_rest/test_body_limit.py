"""BodyLimitASGIMiddleware behavior (mirrors TS routes.ts's bodyLimit and its DEFAULT_MAX_BODY_BYTES check —
see conformance-manifest REST-BODY tests on the TS side and packages/host-rest/src/routes.ts).

Covers both admission paths: a declared (and oversized) Content-Length rejected without reading any body off
the wire, and a body with no usable Content-Length (chunked / streamed) rejected once the accumulated bytes
cross the limit.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .conftest import PREFIX, build_harness


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


_EXPECTED_BODY = {"error": {"code": "BAD_REQUEST", "message": "request body too large"}}


def test_body_limit_rejects_oversized_declared_content_length(tmp_path: Path) -> None:
    """A regular (non-streamed) request carries a Content-Length header that httpx computes up front, so
    this exercises the "reject before reading the body" path."""
    harness = build_harness(tmp_path, max_body_bytes=32)
    payload = {"events": [{"kind": "rendered", "specHash": "sha256:" + "a" * 64}]}
    assert len(json.dumps(payload).encode("utf-8")) > 32

    res = harness.client.post(_url("/telemetry"), json=payload)

    assert res.status_code == 413
    assert res.json() == _EXPECTED_BODY
    # The oversized body never reached the domain — no telemetry event was recorded.
    lineage = harness.client.get(_url("/lineage"), params={"limit": 1000}).json()["events"]
    assert lineage == []


def test_body_limit_rejects_oversized_body_without_content_length(tmp_path: Path) -> None:
    """A generator request body has no Content-Length (httpx sends it chunked instead), so this exercises
    the accumulate-then-reject path rather than the declared-Content-Length shortcut."""
    harness = build_harness(tmp_path, max_body_bytes=32)

    def chunks() -> Any:
        yield b'{"events": [{"kind": "rendered", '
        yield b'"specHash": "sha256:' + b"a" * 64 + b'"}]}'

    res = harness.client.post(
        _url("/telemetry"),
        content=chunks(),
        headers={"content-type": "application/json"},
    )

    assert "content-length" not in {k.lower() for k in res.request.headers}
    assert res.status_code == 413
    assert res.json() == _EXPECTED_BODY


def test_body_limit_allows_a_request_within_the_default_cap(tmp_path: Path) -> None:
    """Sanity check: the default 1 MiB cap (no override) does not interfere with an ordinary request."""
    harness = build_harness(tmp_path)
    res = harness.client.post(_url("/telemetry"), json={"events": []})
    assert res.status_code == 200

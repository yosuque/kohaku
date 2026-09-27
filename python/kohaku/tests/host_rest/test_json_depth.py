"""Regression coverage for the deep-nesting recursion-DoS fix (mirrors TS's
packages/host-rest/test/json-depth.test.ts). Complements test_bodies.py's boundary coverage (depth 32
accepted / 33 rejected, exercised directly against the bodies.py parsers) with the depths from the original
report (5000 / 100000), exercised end-to-end over the FastAPI app -- since those two depths take genuinely
different code paths in _routes/shared.py's _read_json:

- 5000: `json.loads` parses it without incident (CPython's json decoder tolerates this depth); rejected by
  _read_json's own _json_depth_ok whole-body check before any route-specific parser sees it.
- 100000: `json.loads` itself raises RecursionError (a catchable RuntimeError subclass, confirmed by direct
  probing -- not a hard, uncatchable stack overflow); _read_json now catches it and treats it the same as any
  other malformed body.

Before the fix, the 100000 case's RecursionError was not caught, so it propagated out of the route handler as
an unhandled exception (a 500), instead of the 400 every other malformed-body case gets.

The payload is a raw JSON *string* (never a Python object passed through json.dumps), the same way a real
request body arrives over the wire, and nests via arrays (`[[[...]]]`, 2 bytes per level) rather than objects
so a 100000-level payload stays a few hundred KB -- comfortably under DEFAULT_MAX_BODY_BYTES (1 MiB).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from .conftest import PREFIX, build_harness


def _deep_array_json(depth: int) -> str:
    return "[" * depth + "]" * depth


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


@pytest.mark.parametrize("depth", [5000, 100_000])
class TestDeeplyNestedRequestBody:
    def test_compose(self, tmp_path: Path, depth: int) -> None:
        harness = build_harness(tmp_path)
        deep = _deep_array_json(depth)
        res = harness.client.post(
            _url("/compose"),
            content=f'{{"intent":{{"canonical":"sales.trend","params":{{"a":{deep}}}}}}}',
            headers={"content-type": "application/json"},
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "BAD_REQUEST"

    def test_events(self, tmp_path: Path, depth: int) -> None:
        harness = build_harness(tmp_path)
        deep = _deep_array_json(depth)
        res = harness.client.post(
            _url("/events"),
            content=(
                '{"intent":{"canonical":"sales.trend","params":{}},'
                f'"event":{{"on":"root.click","payload":{{"a":{deep}}}}}}}'
            ),
            headers={"content-type": "application/json"},
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "BAD_REQUEST"

    def test_binding_action(self, tmp_path: Path, depth: int) -> None:
        harness = build_harness(tmp_path)
        deep = _deep_array_json(depth)
        res = harness.client.post(
            _url("/binding/action"),
            content=f'{{"action":"widget.submit","payload":{{"a":{deep}}}}}',
            headers={"content-type": "application/json"},
        )
        # Rejected by the body parse before the (missing) capability is even checked.
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "BAD_REQUEST"

    def test_whole_body_nested_this_deep_not_inside_a_params_field(
        self, tmp_path: Path, depth: int
    ) -> None:
        """Exercises _read_json's own whole-body _json_depth_ok check (rather than bodies.py's field-level
        one): the deep array sits directly under "intent", not nested under params/payload."""
        harness = build_harness(tmp_path)
        deep = _deep_array_json(depth)
        res = harness.client.post(
            _url("/compose"),
            content=f'{{"intent":{deep}}}',
            headers={"content-type": "application/json"},
        )
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "BAD_REQUEST"


def test_read_json_directly_confirms_which_depth_actually_triggers_recursion_error() -> None:
    """Pins the two-path claim in the module docstring: json.loads on a 5000-deep array succeeds (rejected
    only by the depth check), while a 100000-deep array raises RecursionError from within json.loads itself."""
    import json

    json.loads(_deep_array_json(5000))  # does not raise
    with pytest.raises(RecursionError):
        json.loads(_deep_array_json(100_000))

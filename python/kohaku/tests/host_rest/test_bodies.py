"""Request-body hardening (mirrors TS host-rest schemas.test.ts): JsonObject nesting-depth cap on
params/payload fields, and the sessionId length cap.
"""

from __future__ import annotations

from typing import Any

from kohaku.host_rest.bodies import (
    parse_action_body,
    parse_compose_body,
    parse_events_body,
    parse_session,
)


def _nested_object(depth: int) -> dict[str, Any]:
    """A dict literal nested `depth` levels deep (a bare {"leaf": True} is depth 1)."""
    obj: dict[str, Any] = {"leaf": True}
    for _ in range(1, depth):
        obj = {"nested": obj}
    return obj


class TestJsonObjectDepthCap:
    def test_compose_body_intent_params_at_32_is_accepted(self) -> None:
        body = parse_compose_body(
            {"intent": {"canonical": "sales.trend", "params": _nested_object(32)}}
        )
        assert body is not None

    def test_compose_body_intent_params_over_32_is_rejected(self) -> None:
        body = parse_compose_body(
            {"intent": {"canonical": "sales.trend", "params": _nested_object(33)}}
        )
        assert body is None

    def test_events_body_payload_over_32_is_rejected(self) -> None:
        body = parse_events_body(
            {
                "intent": {"canonical": "sales.trend", "params": {}},
                "event": {"on": "f.submit", "payload": _nested_object(33)},
            }
        )
        assert body is None

    def test_events_body_payload_at_32_is_accepted(self) -> None:
        body = parse_events_body(
            {
                "intent": {"canonical": "sales.trend", "params": {}},
                "event": {"on": "f.submit", "payload": _nested_object(32)},
            }
        )
        assert body is not None

    def test_action_body_payload_over_32_is_rejected(self) -> None:
        body = parse_action_body({"action": "sales.update", "payload": _nested_object(33)})
        assert body is None

    def test_gui_semantic_input_params_over_32_is_rejected(self) -> None:
        body = parse_compose_body(
            {"input": {"kind": "gui", "action": "filter.change", "params": _nested_object(33)}}
        )
        assert body is None

    def test_gui_semantic_input_current_params_over_32_is_rejected(self) -> None:
        body = parse_compose_body(
            {
                "input": {
                    "kind": "gui",
                    "action": "filter.change",
                    "params": {},
                    "current": {
                        "canonical": "sales.trend",
                        "params": _nested_object(33),
                        "hash": "sha256:" + "0" * 64,
                    },
                }
            }
        )
        assert body is None


class TestSessionIdLengthCap:
    def test_session_id_at_128_is_accepted(self) -> None:
        session = parse_session({"surface": "web", "sessionId": "a" * 128})
        assert session is not None

    def test_session_id_over_128_is_rejected(self) -> None:
        assert parse_session({"surface": "web", "sessionId": "a" * 129}) is None

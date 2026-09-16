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
    parse_telemetry_body,
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


class TestSessionSurfaceLocaleLengthCaps:
    """Mirrors TS routes/schemas.ts's SessionSchema surface/locale .max(64) (§4.5: bound client-supplied
    strings flowing into lineage records / recorder keys, same rationale as sessionId above)."""

    def test_surface_at_64_is_accepted(self) -> None:
        assert parse_session({"surface": "s" * 64}) is not None

    def test_surface_over_64_is_rejected(self) -> None:
        assert parse_session({"surface": "s" * 65}) is None

    def test_locale_at_64_is_accepted(self) -> None:
        assert parse_session({"surface": "web", "locale": "l" * 64}) is not None

    def test_locale_over_64_is_rejected(self) -> None:
        assert parse_session({"surface": "web", "locale": "l" * 65}) is None


class TestTelemetryBodyLengthCaps:
    """Mirrors TS routes/schemas.ts's TelemetryBodySchema specHash/artifactId .max(128) and
    surface/renderer .max(64)."""

    def test_rendered_spec_hash_at_128_is_accepted(self) -> None:
        events = parse_telemetry_body({"events": [{"kind": "rendered", "specHash": "h" * 128}]})
        assert events is not None

    def test_rendered_spec_hash_over_128_is_rejected(self) -> None:
        events = parse_telemetry_body({"events": [{"kind": "rendered", "specHash": "h" * 129}]})
        assert events is None

    def test_rendered_renderer_over_64_is_rejected(self) -> None:
        events = parse_telemetry_body(
            {"events": [{"kind": "rendered", "specHash": "h", "renderer": "r" * 65}]}
        )
        assert events is None

    def test_component_used_artifact_id_at_128_is_accepted(self) -> None:
        events = parse_telemetry_body({"events": [{"kind": "componentUsed", "artifactId": "a" * 128}]})
        assert events is not None

    def test_component_used_artifact_id_over_128_is_rejected(self) -> None:
        events = parse_telemetry_body({"events": [{"kind": "componentUsed", "artifactId": "a" * 129}]})
        assert events is None

    def test_component_used_surface_over_64_is_rejected(self) -> None:
        events = parse_telemetry_body(
            {"events": [{"kind": "componentUsed", "artifactId": "a", "surface": "s" * 65}]}
        )
        assert events is None

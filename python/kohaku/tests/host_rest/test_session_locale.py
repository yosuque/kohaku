"""session.locale wire acceptance (mirrors TS host-rest session-locale.test.ts).

The optional locale tag on the session body must be threaded through to_session into
SessionContext.locale so SemanticPort.normalize (and the composer policyFor hook) can observe it.
Absent locale keeps the legacy SessionContext shape; a non-string locale is a 400.
"""

from __future__ import annotations

from typing import Any

from kohaku.host_rest._fastapi_routes import to_session
from kohaku.host_rest.bodies import parse_session
from kohaku.spec import Principal


def _url(path: str) -> str:
    return f"/api/kohaku{path}"


class TestParseSession:
    def test_accepts_string_locale(self) -> None:
        session = parse_session({"surface": "web", "locale": "ja"})
        assert session is not None
        assert session.locale == "ja"

    def test_locale_defaults_to_none(self) -> None:
        session = parse_session({"surface": "web"})
        assert session is not None
        assert session.locale is None

    def test_rejects_non_string_locale(self) -> None:
        assert parse_session({"surface": "web", "locale": 42}) is None


class TestToSession:
    def test_threads_locale_into_session_context(self) -> None:
        principal = Principal(id="u", roles=["user"])
        session = parse_session({"surface": "web", "locale": "ja"})
        assert session is not None
        ctx = to_session(session, principal, None)
        assert ctx.locale == "ja"

    def test_absent_locale_stays_none(self) -> None:
        principal = Principal(id="u", roles=["user"])
        session = parse_session(None)
        assert session is not None
        ctx = to_session(session, principal, None)
        assert ctx.locale is None


class TestRouteAcceptance:
    def test_normalize_accepts_session_locale(self, client: Any) -> None:
        res = client.post(
            _url("/intent/normalize"),
            json={
                "input": {"kind": "nl", "text": "show the trend"},
                "session": {"surface": "web", "locale": "ja"},
            },
        )
        assert res.status_code == 200

    def test_normalize_rejects_non_string_locale(self, client: Any) -> None:
        res = client.post(
            _url("/intent/normalize"),
            json={
                "input": {"kind": "nl", "text": "show the trend"},
                "session": {"surface": "web", "locale": 42},
            },
        )
        assert res.status_code == 400

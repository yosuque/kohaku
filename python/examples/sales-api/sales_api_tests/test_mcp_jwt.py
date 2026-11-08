"""The Python MCP profile with ``KOHAKU_AUTHZ=jwt`` (port of the jwt half of TS apps/sample-mcp's setup.ts: the default
per-tool-call ``resolvePrincipal`` built from the HTTP request's own bearer token).

Driven through the real Streamable HTTP app (Starlette TestClient, no socket): the principal of a tool call is the
one in that call's ``Authorization: Bearer`` JWT, and a missing or invalid token fails the call closed instead of
running it anonymously.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import jwt
import pytest
from starlette.testclient import TestClient

from sales_api.fake_llm import create_deterministic_fake_llm
from sales_api.mcp_http import build_starlette_app
from sales_api.mcp_setup import create_kohaku_mcp_setup

SECRET = "test-secret-at-least-32-bytes-long-000"
_ACCEPT = {"Accept": "application/json, text/event-stream"}


def _jwt(**claims: Any) -> str:
    return jwt.encode({**claims, "exp": int(time.time()) + 300}, SECRET, algorithm="HS256")


@pytest.fixture
def jwt_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KOHAKU_AUTHZ", "jwt")
    monkeypatch.setenv("KOHAKU_JWT_SECRET", SECRET)
    monkeypatch.setenv("KOHAKU_CAPABILITY_SECRET", "real-capability-secret")


def _client(tmp_path: Path) -> TestClient:
    setup = asyncio.run(
        create_kohaku_mcp_setup(llm=create_deterministic_fake_llm(), data_dir=tmp_path)
    )
    return TestClient(
        build_starlette_app(setup, allowed_hosts=None, host="127.0.0.1"),
        base_url="http://localhost",
    )


def _rpc(
    client: TestClient, method: str, params: dict[str, Any], *, id: int, headers: dict[str, str]
) -> dict[str, Any]:
    res = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": id, "method": method, "params": params},
        headers=headers,
    )
    assert res.status_code == 200, res.text
    body = res.text
    if res.headers.get("content-type", "").startswith("text/event-stream"):
        body = next(line[5:].strip() for line in body.splitlines() if line.startswith("data:"))
    parsed: dict[str, Any] = json.loads(body)
    return parsed


def _call_tool(client: TestClient, bearer: str | None) -> dict[str, Any]:
    headers = dict(_ACCEPT)
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    init = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test-mcp-jwt", "version": "0"},
            },
        },
        headers=headers,
    )
    assert init.status_code == 200, init.text
    session = init.headers.get("mcp-session-id")
    if session is not None:
        headers["mcp-session-id"] = session
    client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers=headers,
    )
    tools = _rpc(client, "tools/list", {}, id=2, headers=headers)
    names = [t["name"] for t in tools["result"]["tools"]]
    assert "kohaku_compose" in names, names
    return _rpc(
        client,
        "tools/call",
        {
            "name": "kohaku_compose",
            "arguments": {"question": "Quarterly sales summary"},
        },
        id=3,
        headers=headers,
    )


class TestMcpProfileUnderJwt:
    def test_a_call_with_a_valid_bearer_runs_as_that_principal(
        self, tmp_path: Path, jwt_env: None
    ) -> None:
        with _client(tmp_path) as client:
            response = _call_tool(client, _jwt(sub="alice", roles=["viewer"], tenant="acme"))
        assert "error" not in response, response
        assert response["result"].get("isError") in (None, False), response

    def test_a_call_without_a_bearer_fails_closed_instead_of_running_anonymous(
        self, tmp_path: Path, jwt_env: None
    ) -> None:
        with _client(tmp_path) as client:
            response = _call_tool(client, None)
        assert response["result"]["isError"] is True, response

    def test_a_call_with_an_invalid_bearer_fails_closed_and_logs_why(
        self, tmp_path: Path, jwt_env: None, caplog: pytest.LogCaptureFixture
    ) -> None:
        with _client(tmp_path) as client:
            response = _call_tool(client, "not-a-jwt")
        assert any("INVALID_TOKEN" in r.getMessage() for r in caplog.records)
        assert response["result"]["isError"] is True, response

    def test_a_token_without_a_tenant_claim_is_still_refused_by_default(
        self, tmp_path: Path, jwt_env: None
    ) -> None:
        # The MCP profile discards the tenant, but the identity resolver still requires the claim
        # (KOHAKU_JWT_REQUIRE_TENANT defaults to on), exactly as in TS.
        with _client(tmp_path) as client:
            response = _call_tool(client, _jwt(sub="alice", roles=["viewer"]))
        assert response["result"]["isError"] is True, response

    def test_the_hmac_default_is_unchanged_and_needs_no_bearer(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("KOHAKU_AUTHZ", raising=False)
        with _client(tmp_path) as client:
            response = _call_tool(client, None)
        assert response["result"].get("isError") in (None, False), response

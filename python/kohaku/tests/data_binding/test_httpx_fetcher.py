"""Tests for the default httpx fetcher (injecting a transport to test without issuing real HTTP).

Replaces the /binding/resolve and /binding/action responses with httpx.MockTransport and confirms that URL,
Bearer, extra headers, and JSON parsing behave the same as the TS default fetcher.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from kohaku.data_binding import (
    BindingClientConfig,
    create_binding_client,
    create_httpx_action_fetcher,
    create_httpx_fetcher,
)

_DATA: dict[str, Any] = {
    "columns": [{"key": "region", "type": "string"}],
    "rows": [{"region": "japan"}],
    "dataVersion": "v1",
}


def test_httpx_fetcher_resolve_sends_ref_bearer_and_headers() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        # ref is %-encoded on the wire (equivalent to TS's encodeURIComponent). The server restores it,
        # so here we compare against the value httpx restored (QueryParams.get).
        seen["path"] = request.url.path
        seen["ref"] = request.url.params.get("ref")
        seen["auth"] = request.headers.get("authorization")
        seen["tenant"] = request.headers.get("x-kohaku-tenant")
        return httpx.Response(200, json=_DATA)

    fetcher = create_httpx_fetcher(
        "http://host/api/kohaku",
        headers=lambda: {"x-kohaku-tenant": "tenant-a"},
        transport=httpx.MockTransport(handler),
    )
    client = create_binding_client(BindingClientConfig(capability="cap", fetcher=fetcher))
    data = asyncio.run(client.resolve("query://sales/summary?fy=2026"))

    rows = data["rows"]
    assert isinstance(rows, list)
    row = rows[0]
    assert isinstance(row, dict)
    assert row["region"] == "japan"
    assert seen["path"] == "/api/kohaku/binding/resolve"
    assert seen["ref"] == "query://sales/summary?fy=2026"
    assert seen["auth"] == "Bearer cap"
    assert seen["tenant"] == "tenant-a"


def test_httpx_action_fetcher_posts_action_and_parses_result() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["method"] = request.method
        seen["content_type"] = request.headers.get("content-type")
        seen["body"] = request.content.decode()
        return httpx.Response(200, json={"result": {"ok": True}, "invalidates": ["query://sales/summary?fy=2026"]})

    action_fetcher = create_httpx_action_fetcher(
        "http://host/api/kohaku", transport=httpx.MockTransport(handler)
    )
    client = create_binding_client(
        BindingClientConfig(capability="cap", base_url="http://host/api/kohaku", action_fetcher=action_fetcher)
    )
    res = asyncio.run(client.invoke_action("annotate", {"note": "x"}))

    assert res.result == {"ok": True}
    assert res.invalidates == ["query://sales/summary?fy=2026"]
    assert seen["method"] == "POST"
    assert seen["url"] == "http://host/api/kohaku/binding/action"
    assert seen["content_type"] == "application/json"
    assert '"action":"annotate"' in seen["body"].replace(" ", "")

"""Tests for the MCP sample's common setup and HTTP helpers
(corresponds to TS: apps/sample-mcp/src/setup.ts / http.ts).

- create_kohaku_mcp_setup: smoke-pins that a Server can be assembled with the governance wiring (fixation_lookup /
  fixations / on_composed / action_effects) included (that create_server does not throw).
- make_snapshot_locator / make_renderer_html_loader: pins the pure logic.
- mcp_http's path-traversal defense / allowed_hosts parsing / Host + Origin validation and CORS: pinned.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from mcp.server import NotificationOptions

from sales_api.fake_llm import create_deterministic_fake_llm
from sales_api.mcp_http import (
    _serve_snapshot_body,
    allowed_hostname_of,
    build_starlette_app,
    parse_allowed_hosts,
)
from sales_api.mcp_setup import (
    KohakuMcpSetup,
    create_kohaku_mcp_setup,
    make_renderer_html_loader,
    make_snapshot_locator,
)


class TestSnapshotLocator:
    def test_local_path_without_base_url(self) -> None:
        loc = make_snapshot_locator(
            snapshot_base_url=None, snapshot_dir=Path("/tmp/snaps"), file_name="snapshot-abc.html"
        )
        assert loc == str(Path("/tmp/snaps") / "snapshot-abc.html")

    def test_public_url_with_base_url(self) -> None:
        loc = make_snapshot_locator(
            snapshot_base_url="https://x.trycloudflare.com",
            snapshot_dir=Path("/tmp/snaps"),
            file_name="snapshot-abc.html",
        )
        assert loc == "https://x.trycloudflare.com/snapshots/snapshot-abc.html"


class TestRendererHtmlLoader:
    def test_absent_returns_fallback_and_not_cached(self, tmp_path: Path) -> None:
        missing = tmp_path / "nope.html"
        load = make_renderer_html_loader(path=missing, fallback="FALLBACK")

        async def _load() -> str:
            return await load()

        assert asyncio.run(_load()) == "FALLBACK"
        # Absence is not cached: if created later, the next call picks it up.
        missing.write_text("<html>built</html>", encoding="utf-8")
        assert asyncio.run(_load()) == "<html>built</html>"
        # A successful read is memoized (returns the previous value even if the file is deleted).
        missing.unlink()
        assert asyncio.run(_load()) == "<html>built</html>"


class TestServeSnapshotBody:
    def test_rejects_traversal(self, tmp_path: Path) -> None:
        status, _ct, _body = _serve_snapshot_body(tmp_path, "../secret")
        assert status == 400

    def test_rejects_path_separators(self, tmp_path: Path) -> None:
        assert _serve_snapshot_body(tmp_path, "a/b")[0] == 400
        assert _serve_snapshot_body(tmp_path, "")[0] == 400

    def test_missing_file_is_404(self, tmp_path: Path) -> None:
        assert _serve_snapshot_body(tmp_path, "snapshot-x.html")[0] == 404

    def test_serves_existing_file(self, tmp_path: Path) -> None:
        (tmp_path / "snapshot-x.html").write_text("<html>ok</html>", encoding="utf-8")
        status, content_type, body = _serve_snapshot_body(tmp_path, "snapshot-x.html")
        assert status == 200
        assert "text/html" in content_type
        assert body == b"<html>ok</html>"


class TestParseAllowedHosts:
    def test_empty_is_no_protection(self) -> None:
        assert parse_allowed_hosts(None) == []
        assert parse_allowed_hosts("") == []

    def test_splits_and_trims(self) -> None:
        assert parse_allowed_hosts("localhost:8791, 127.0.0.1:8791 ,") == [
            "localhost:8791",
            "127.0.0.1:8791",
        ]


class TestSetupSmoke:
    def test_create_server_builds_with_control_wiring(self, tmp_path: Path) -> None:
        # It can attach with the governance wiring (fixation_lookup / fixations / on_composed / action_effects) included.
        setup = asyncio.run(
            create_kohaku_mcp_setup(llm=create_deterministic_fake_llm(), data_dir=tmp_path)
        )
        assert setup.snapshot_dir == tmp_path / "snapshots"
        server = setup.create_server()
        assert server is not None
        # Multiple Servers can be created from the same setup (equivalent to HTTP sessions).
        assert setup.create_server() is not None
        # mcp 2.x's `Server.add_request_handler`-based attach (server.py's low-level registration) must still
        # leave `get_capabilities()` able to see tools/list and resources/list as registered — the one gray
        # area this attach style has (registering spec methods via the same API custom/extension methods use;
        # see attach_kohaku_to_mcp_server's risk note) is pinned here so a future SDK change that stops
        # deriving capabilities from `_request_handlers` fails this test rather than silently under-advertising.
        capabilities = server.get_capabilities(NotificationOptions(), {})
        assert capabilities.tools is not None
        assert capabilities.resources is not None

    def test_data_dir_falls_back_to_kohaku_data_dir_env_var(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Mirrors __main__.py's REST-side handling and TS sample-api's: KOHAKU_DATA_DIR overrides the
        # persistence directory when no explicit data_dir argument is given (e.g. a mktemp'd directory
        # for CI/conformance runs so they never touch the checked-out repo's local demo state).
        monkeypatch.setenv("KOHAKU_DATA_DIR", str(tmp_path))
        setup = asyncio.run(create_kohaku_mcp_setup(llm=create_deterministic_fake_llm()))
        assert setup.data_dir == tmp_path
        assert setup.snapshot_dir == tmp_path / "snapshots"

    def test_explicit_data_dir_wins_over_kohaku_data_dir_env_var(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        env_dir = tmp_path / "from-env"
        arg_dir = tmp_path / "from-arg"
        monkeypatch.setenv("KOHAKU_DATA_DIR", str(env_dir))
        setup = asyncio.run(
            create_kohaku_mcp_setup(llm=create_deterministic_fake_llm(), data_dir=arg_dir)
        )
        assert setup.data_dir == arg_dir


class TestBuildStarletteApp:
    """Constructs the Streamable HTTP ASGI app in-process (via Starlette's TestClient, no real socket) rather
    than starting mcp_http.main()'s uvicorn server — pins that `build_starlette_app` (mcp 2.x's
    `Server.streamable_http_app(...)` plus the custom snapshot route and CORS middleware layered on
    afterward, see mcp_http.py's doc comment) actually serves both the MCP wire and the snapshot route."""

    @staticmethod
    def _setup(tmp_path: Path) -> KohakuMcpSetup:
        return asyncio.run(
            create_kohaku_mcp_setup(llm=create_deterministic_fake_llm(), data_dir=tmp_path)
        )

    def test_snapshot_route_is_reachable_alongside_the_mcp_route(self, tmp_path: Path) -> None:
        from starlette.testclient import TestClient

        setup = self._setup(tmp_path)
        app = build_starlette_app(setup, allowed_hosts=None, host="127.0.0.1")
        with TestClient(app, base_url="http://localhost") as client:
            # The custom_starlette_routes snapshot route and the SDK-built /mcp route coexist on one app.
            missing = client.get("/snapshots/does-not-exist.html")
            assert missing.status_code == 404

            init = client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "test-mcp-setup", "version": "0"},
                    },
                },
                headers={"Accept": "application/json, text/event-stream"},
            )
            assert init.status_code == 200
            assert '"protocolVersion":"2025-06-18"' in init.text

    def test_cors_echoes_only_an_allowed_origin_never_a_wildcard(self, tmp_path: Path) -> None:
        from starlette.testclient import TestClient

        setup = self._setup(tmp_path)
        app = build_starlette_app(
            setup, allowed_hosts=None, allowed_origins=["claude.ai"], host="127.0.0.1"
        )
        with TestClient(app, base_url="http://localhost") as client:
            allowed = client.options(
                "/mcp",
                headers={"Origin": "https://claude.ai", "Access-Control-Request-Method": "POST"},
            )
            assert allowed.headers.get("access-control-allow-origin") == "https://claude.ai"
            local = client.options(
                "/mcp",
                headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
            )
            assert local.headers.get("access-control-allow-origin") == "http://localhost:5173"
            denied = client.options(
                "/mcp",
                headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
            )
            assert denied.headers.get("access-control-allow-origin") is None

    def test_host_and_origin_are_validated_by_default_on_both_routes(self, tmp_path: Path) -> None:
        from starlette.testclient import TestClient

        setup = self._setup(tmp_path)
        app = build_starlette_app(setup, allowed_hosts=["tunnel.example"], host="127.0.0.1")
        with TestClient(app, base_url="http://localhost") as client:
            # A bad Host is rejected on the snapshot route too (streamable_http_app only guards /mcp).
            assert client.get("/snapshots/x.html", headers={"Host": "evil.example"}).status_code == 421
            assert client.get("/snapshots/x.html", headers={"Host": "tunnel.example"}).status_code == 404
            assert (
                client.get("/snapshots/x.html", headers={"Origin": "https://evil.example"}).status_code
                == 403
            )
            body = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "t", "version": "0"},
                },
            }
            accept = {"Accept": "application/json, text/event-stream"}
            bad_host = client.post("/mcp", json=body, headers={**accept, "Host": "evil.example"})
            assert bad_host.status_code == 421
            bad_origin = client.post("/mcp", json=body, headers={**accept, "Origin": "https://evil.example"})
            assert bad_origin.status_code == 403
            ok = client.post("/mcp", json=body, headers=accept)
            assert ok.status_code == 200


class TestAllowedHostnameOf:
    @pytest.mark.parametrize(
        ("entry", "hostname"),
        [
            ("localhost", "localhost"),
            ("allowed.example:9999", "allowed.example"),
            ("https://x.trycloudflare.com", "x.trycloudflare.com"),
            ("https://x.example:8443/path", "x.example"),
            ("[::1]:8788", "[::1]"),
            ("[::1]", "[::1]"),
            ("  spaced.example  ", "spaced.example"),
        ],
    )
    def test_strips_scheme_port_and_path(self, entry: str, hostname: str) -> None:
        assert allowed_hostname_of(entry) == hostname

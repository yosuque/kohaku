"""Tests for the MCP sample's common setup and HTTP helpers
(corresponds to TS: apps/sample-mcp/src/setup.ts / http.ts).

- create_kohaku_mcp_setup: smoke-pins that a Server can be assembled with the governance wiring (fixation_lookup /
  fixations / on_composed / action_effects) included (that create_server does not throw).
- make_snapshot_locator / make_renderer_html_loader: pins the pure logic.
- mcp_http's path-traversal defense / allowed_hosts parsing: pinned.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from sales_api.fake_llm import create_deterministic_fake_llm
from sales_api.mcp_http import _serve_snapshot_body, parse_allowed_hosts
from sales_api.mcp_setup import (
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

"""Tests for the L2 verification JS sidecar (l2_js_sidecar).

The substantive lint / smoke tests **assume Node is present because we are inside the repository** and actually
delegate to the TS CLI (kohaku smoke-l2) (skipped in environments where Node/CLI is not co-located). In
addition, they verify fail-open (a nonexistent node_command).
"""

from __future__ import annotations

import asyncio
import os

import pytest

from kohaku.composer.context import L2SmokeContext
from kohaku.composer.l2_js_sidecar import create_l2_js_sidecar
from kohaku.spec import DataShape

# Keep the ready-wait short; give the process cap headroom to include node/tsx startup (keep tests fast).
_SIDECAR = create_l2_js_sidecar(ready_timeout_ms=300, timeout_s=30.0)
_NODE_AVAILABLE = _SIDECAR.is_available()
# When the Node sidecar is required (e.g. in CI), forbid a silent skip (fail if not detected).
_REQUIRE_NODE = os.environ.get("KOHAKU_REQUIRE_NODE_SIDECAR", "") == "1"
if _REQUIRE_NODE and not _NODE_AVAILABLE:
    raise RuntimeError(
        "KOHAKU_REQUIRE_NODE_SIDECAR=1 but the Node/CLI sidecar is unavailable"
        f"(cli={_SIDECAR.cli_path!r})"
    )

_SHAPE = DataShape.model_validate(
    {
        "columns": [
            {"name": "month", "type": "date", "role": "time"},
            {"name": "amount", "type": "number", "role": "measure"},
        ]
    }
)

# HTML that touches no lexical lint (missing ready, etc.) and contains only a JS syntax error (an unterminated string literal).
_SYNTAX_ERROR_HTML = (
    "<!DOCTYPE html><html><body><script>\n"
    "let s = '<div>\n"
    "';\n"
    "window.kohaku.ready();\n"
    "</script></body></html>"
)

_VALID_HTML = (
    "<!DOCTYPE html><html><body><div id=x></div><script>"
    "window.kohaku.fetchData('query://x').then(function(d){"
    "document.getElementById('x').textContent=String(d.rows.length);window.kohaku.ready();});"
    "</script></body></html>"
)


@pytest.mark.skipif(not _NODE_AVAILABLE, reason="skipped because Node/CLI is not co-located")
class TestSidecarLive:
    def test_lint_detects_syntax_error(self) -> None:
        issues = asyncio.run(_SIDECAR.lint(_SYNTAX_ERROR_HTML))
        assert any(i.startswith("L2_SCRIPT_SYNTAX") for i in issues)

    def test_lint_passes_valid_html(self) -> None:
        assert asyncio.run(_SIDECAR.lint(_VALID_HTML)) == []

    def test_smoke_ready_html_is_clean(self) -> None:
        html = "<!DOCTYPE html><html><body><script>window.kohaku.ready();</script></body></html>"
        assert asyncio.run(_SIDECAR.smoke(html, L2SmokeContext())) == []

    def test_smoke_no_ready_reports_issue(self) -> None:
        html = "<!DOCTYPE html><html><body><script>void 0;</script></body></html>"
        issues = asyncio.run(_SIDECAR.smoke(html, L2SmokeContext(ref="query://x", shape=_SHAPE)))
        assert len(issues) == 1
        assert issues[0].startswith("L2_SMOKE_NO_READY")


class TestFailOpen:
    def test_missing_node_is_unavailable(self) -> None:
        sidecar = create_l2_js_sidecar(node_command=["/nonexistent/node-xyz-123"])
        assert sidecar.is_available() is False

    def test_missing_node_lint_returns_empty(self) -> None:
        # node cannot start (executable missing) → fail-open with [] (check skipped).
        sidecar = create_l2_js_sidecar(node_command=["/nonexistent/node-xyz-123"])
        assert asyncio.run(sidecar.lint(_SYNTAX_ERROR_HTML)) == []

    def test_missing_node_smoke_returns_empty(self) -> None:
        sidecar = create_l2_js_sidecar(node_command=["/nonexistent/node-xyz-123"])
        assert asyncio.run(sidecar.smoke(_VALID_HTML, L2SmokeContext(shape=_SHAPE))) == []

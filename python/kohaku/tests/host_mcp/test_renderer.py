"""load_default_renderer_html (TS counterpart: @kohaku-ui/mcp-renderer's loadRendererHtml)."""

from __future__ import annotations

from pathlib import Path

import pytest

from kohaku.host_mcp import DEFAULT_RENDERER_PLACEHOLDER_HTML, load_default_renderer_html


def test_no_path_returns_the_placeholder() -> None:
    assert load_default_renderer_html() == DEFAULT_RENDERER_PLACEHOLDER_HTML
    assert load_default_renderer_html(None) == DEFAULT_RENDERER_PLACEHOLDER_HTML


def test_placeholder_is_a_readable_html_document() -> None:
    # Not asserting exact wording (that would pin prose) -- just that it is what an MCP host would actually
    # render: a well-formed-looking HTML document, not an empty string or an error message.
    assert DEFAULT_RENDERER_PLACEHOLDER_HTML.startswith("<!DOCTYPE html>")
    assert "<html" in DEFAULT_RENDERER_PLACEHOLDER_HTML
    assert "</html>" in DEFAULT_RENDERER_PLACEHOLDER_HTML


def test_given_path_reads_that_file(tmp_path: Path) -> None:
    renderer_path = tmp_path / "renderer.html"
    renderer_path.write_text("<html><body>real renderer</body></html>", encoding="utf-8")
    assert load_default_renderer_html(str(renderer_path)) == "<html><body>real renderer</body></html>"


def test_given_path_is_a_string_not_a_path_object(tmp_path: Path) -> None:
    # The signature is `path: str | None` (not `str | Path | None`) -- confirm a plain str works end to end
    # (Path(str_path) is how the implementation itself bridges to pathlib).
    renderer_path = tmp_path / "renderer.html"
    renderer_path.write_text("ok", encoding="utf-8")
    result = load_default_renderer_html(path=str(renderer_path))
    assert isinstance(result, str)
    assert result == "ok"


def test_missing_given_path_raises_rather_than_silently_falling_back() -> None:
    # Unlike the "no argument" branch, a path that does not exist is a caller error, not a cue to fall back
    # to the placeholder -- surfaces as a real FileNotFoundError instead of silently hiding the misconfiguration.
    with pytest.raises(FileNotFoundError):
        load_default_renderer_html("/nonexistent/path/to/renderer.html")

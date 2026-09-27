"""Loads the shared MCP Apps renderer bundle (TS counterpart: `@kohaku-ui/mcp-renderer`'s `loadRendererHtml`).

Unlike TS, the `kohaku-ui` wheel does not (yet) bundle a pre-built `renderer.html` of its own -- shipping
one is a follow-up ticket. `load_default_renderer_html` mirrors the TS function's shape for the day that
lands (`AttachOptions.renderer_html` already accepts either a plain string or a callable, so a caller can
switch to a real bundled asset later with no signature change on their side): given a `path`, it reads that
file; given none, it returns a static placeholder in the same style as the sample host's own fallback
(`examples/sales-api/src/sales_api/mcp_setup.py`'s `_FALLBACK_HTML`), so a Python host that has not wired a
real renderer build still gets an explanatory page instead of an empty iframe.
"""

from __future__ import annotations

from pathlib import Path

DEFAULT_RENDERER_PLACEHOLDER_HTML = (
    "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
    "<title>kohaku renderer not available</title></head>"
    "<body style='font-family:sans-serif;padding:24px;color:#475569'>"
    "The shared MCP Apps renderer is not bundled with kohaku-ui yet. Pass a path to "
    "load_default_renderer_html() pointing at a built renderer.html (e.g. from "
    "@kohaku-ui/mcp-renderer's `pnpm run build`, or your own MCP Apps renderer build)."
    "</body></html>"
)
"""Returned by `load_default_renderer_html(None)`. Not cached/memoized (unlike TS's `loadRendererHtml`, which
memoizes a large single-file read) -- this is a short literal, so there is nothing worth caching."""


def load_default_renderer_html(path: str | None = None) -> str:
    """Reads the renderer HTML at `path`, or returns `DEFAULT_RENDERER_PLACEHOLDER_HTML` when `path` is `None`.

    `path` is any file on disk holding a single-file MCP Apps renderer bundle -- e.g. a copy of
    `@kohaku-ui/mcp-renderer`'s `dist/renderer.html`, or a product's own build. Raises `FileNotFoundError`
    (via `pathlib.Path.read_text`) if `path` is given but does not exist -- a caller that wants the
    placeholder-on-missing-file behavior `make_renderer_html_loader` in the sample host provides should keep
    using that helper instead; this function's own "no argument" branch is a fixed placeholder, not a
    fallback for a path that turned out not to exist.
    """
    if path is None:
        return DEFAULT_RENDERER_PLACEHOLDER_HTML
    return Path(path).read_text(encoding="utf-8")

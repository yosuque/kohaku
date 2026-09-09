"""Embedding of the self-contained snapshot HTML (port of injectSnapshot in packages/host-mcp-apps/src/server.ts).

Replaces the shared renderer's #kohaku-snapshot placeholder with {spec, data}. The generated HTML strictly adheres to
a form the TS renderer can read (the embedding marker, `<` escaped as \\u003c).
"""

from __future__ import annotations

import json
import re

from kohaku.spec import TabularData, UISpec

SNAPSHOT_PLACEHOLDER_RE = re.compile(r'(<script id="kohaku-snapshot"[^>]*>)null(</script>)')
"""Detects the #kohaku-snapshot placeholder (`null`) inside the shared renderer (survives even after the single-file build)."""


class RendererUnbuiltError(ValueError):
    """Raised when the shared renderer HTML has no #kohaku-snapshot placeholder (renderer unbuilt /
    FALLBACK_HTML). Carries `code` so it is recognized as a deliberate, host-authored guidance error
    (kohaku.host_core's is_typed_host_error) — its message still reaches the caller instead of collapsing to
    the generic internal-error text (see host_mcp/server.py's _safe_tool).
    """

    code = "RENDERER_UNBUILT"


def inject_snapshot(html: str, spec: UISpec, data: dict[str, TabularData]) -> str:
    """Replace the shared renderer's #kohaku-snapshot placeholder (`null`) with the {spec, data} JSON.

    If the placeholder is absent (= renderer unbuilt / FALLBACK_HTML), raises an exception directing a rebuild.
    """
    if SNAPSHOT_PLACEHOLDER_RE.search(html) is None:
        raise RendererUnbuiltError(
            'The shared renderer has no <script id="kohaku-snapshot"> placeholder. '
            "Please rebuild with pnpm --filter @kohaku-ui-sample/mcp build:renderer."
        )
    payload = {
        "spec": spec.to_wire(),
        "data": {ref: td.to_wire() for ref, td in data.items()},
    }
    # Escape every `<` in the JSON string to \\u003c. An HTML script closing tag terminates case-insensitively and even
    # on whitespace/newlines (</SCRIPT> and </script > also close), so escaping only the exact `</script>` would let
    # variants pass through and allow a breakout. If no `<` remains, no closing tag can form at all.
    # `<` is a JSON escape, so json.loads / JSON.parse restore it to `<` (reading is unchanged).
    # Use compact separators to align with TS's JSON.stringify.
    json_str = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace(
        "<", "\\u003c"
    )

    # Pass the replacement as a function (so the `$` in $ref / $state, etc., and the `\` in the embedded JSON are not
    # misinterpreted as re.sub special replacements). Replace only the first occurrence (same as TS's String.replace(regex)).
    def _replace(match: re.Match[str]) -> str:
        return f"{match.group(1)}{json_str}{match.group(2)}"

    return SNAPSHOT_PLACEHOLDER_RE.sub(_replace, html, count=1)

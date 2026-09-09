"""MCP Apps (SEP-1865) canonical _meta constants and assembly (port of packages/host-mcp-apps/src/meta.ts).

The key strings (modern nested / legacy flat) are made to match TS exactly, since they are the crux of host compatibility.
"""

from __future__ import annotations

from typing import Any, Literal

RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"
"""The canonical MIME for MCP Apps (SEP-1865). Matched to @modelcontextprotocol/ext-apps's public constant
(ext-apps is a browser-side SDK, so the server side holds the value directly)."""

UI_META_KEY = "ui"
"""The modern (nested) _meta key. Since the SEP-1865 formalization (2026-01-26) this
`ui: {resourceUri, visibility}` is canonical, and ChatGPT etc. look at it first."""

RESOURCE_URI_META_KEY = "ui/resourceUri"
"""The legacy (flat) _meta key. Co-emitted for backward compatibility with hosts that only look at modern."""

VISIBILITY_META_KEY = "ui/visibility"
"""The legacy (flat) _meta key (visibility)."""

RENDERER_RESOURCE_URI = "ui://kohaku/renderer.html"
"""The ui:// resource URI of the shared renderer (renders the UI Spec with the same code as the Web)."""

INITIAL_DATA_META_KEY = "kohaku/initialData"
"""The key that co-embeds the initial data (server-side-preresolved `{effective ref: TabularData}`) into the tool
result's `_meta`. `_meta` does not enter the model's context and is transferred only to the widget, so the
initial display can be complete while upholding the "bulk data does not pass through the model" principle. The
renderer (apps/sample-mcp/renderer/main.tsx) reads this key's literal string directly (it does not import
host-mcp-apps, for dependency direction / to avoid single-file bundle bloat; the match is guaranteed by tests)."""

CAPABILITY_META_KEY = "kohaku/capability"
"""The key that co-embeds the compose-issued capability token into a tool result's `_meta`, alongside
INITIAL_DATA_META_KEY. Previously the capability rode `structuredContent.capability`, which is model-visible: a
host that ignores `kohaku_action`'s app-only visibility hint (or a prompt-injected instruction) could then have
the model itself read the token and drive `${prefix}_action` with an arbitrary payload. `_meta` does not enter
the model's context and is transferred only to the widget, so moving the token here closes that path the same
way INITIAL_DATA_META_KEY already does for bulk data. The renderer (apps/sample-mcp/renderer/host-integration.ts)
reads this key's literal string directly (it does not import host-mcp-apps; the match is guaranteed by a TS test)."""

ToolVisibility = Literal["model", "app"]


def resource_ui_meta() -> dict[str, Any]:
    """The shared renderer resource's `_meta` (SEP-1865 resource-side UI metadata).

    csp / permissions are the jurisdiction of the **resource-side** `_meta.ui`, not the tool side. The shared renderer
    is a single-file bundle and even fetches data via the bridge (app-only tools), so it **needs no external origins =
    explicitly declares every csp allowlist as an empty array** (rather than omitting them and deferring to host
    defaults, it tells the host that the strictest sandbox may be applied). permissions (camera, etc.) are unneeded, so
    they are not declared (undeclared = not requested). Put it on both resources/list and the contents of
    resources/read (SEP-1865 specifies contents-side precedence — no difference when both are equal). Made to match the
    wire of TS's packages/host-mcp-apps/src/meta.ts resourceUiMeta() (the match is guaranteed by tests).
    """
    return {
        "ui": {
            "csp": {
                "connectDomains": [],
                "resourceDomains": [],
                "frameDomains": [],
                "baseUriDomains": [],
            }
        }
    }


def tool_ui_meta(
    *,
    resource_uri: str | None = None,
    visibility: list[ToolVisibility] | None = None,
) -> dict[str, Any]:
    """Assemble a tool's _meta (UI declaration).

    With the SEP-1865 formalization (2026-01-26), the UI declaration's canonical form is the nested
    `_meta.ui.{resourceUri,visibility}` (modern), and some hosts (ChatGPT, etc.) look only at modern. Meanwhile, older
    hosts look at the flat `_meta["ui/resourceUri"]` / `_meta["ui/visibility"]` (legacy). So the tool is recognized as
    a UI tool on either host, **co-emit modern and legacy** (with identical values).
    """
    ui: dict[str, Any] = {}
    if resource_uri is not None:
        ui["resourceUri"] = resource_uri
    if visibility is not None:
        ui["visibility"] = list(visibility)

    meta: dict[str, Any] = {}
    # modern (nested): canonical since the SEP-1865 formalization
    if len(ui) > 0:
        meta[UI_META_KEY] = ui
    # legacy (flat): backward compatibility
    if resource_uri is not None:
        meta[RESOURCE_URI_META_KEY] = resource_uri
    if visibility is not None:
        meta[VISIBILITY_META_KEY] = list(visibility)
    return meta

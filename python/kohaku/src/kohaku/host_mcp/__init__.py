"""kohaku.host_mcp — the Kohaku Protocol MCP Apps profile (SEP-1865).

Port of packages/host-mcp-apps. Attaches to the low-level Server of the mcp SDK (the official Python SDK,
mcp>=2.2), registering tools/list, tools/call, resources/list and resources/read via
`Server.add_request_handler`. mcp is an optional dependency (`pip install 'kohaku-ui[mcp]'`), and its import
is deferred until attach runs (importing this package itself does not fail without mcp).
"""

# IntentToolSource is defined in kohaku.intents. Re-exported here as an input type for host_mcp.
from kohaku.intents import IntentToolSource

from .fallback import spec_to_text
from .intent_tools import (
    IntentToolDef,
    IntentToolsOptions,
    intent_tools_from_catalog,
    object_schema_to_json_schema,
    to_mcp_tool_name,
)
from .meta import (
    CAPABILITY_META_KEY,
    INITIAL_DATA_META_KEY,
    RENDERER_RESOURCE_URI,
    RESOURCE_MIME_TYPE,
    RESOURCE_URI_META_KEY,
    UI_META_KEY,
    VISIBILITY_META_KEY,
    ToolVisibility,
    resource_ui_meta,
    tool_ui_meta,
)
from .server import (
    INITIAL_DATA_BUDGET_CHARS,
    ActionEffects,
    AttachOptions,
    McpErrorInfo,
    McpFixationsApi,
    McpHostDeps,
    attach_kohaku_to_mcp_server,
)
from .snapshot import inject_snapshot

__all__ = [
    "CAPABILITY_META_KEY",
    "INITIAL_DATA_BUDGET_CHARS",
    "INITIAL_DATA_META_KEY",
    "RENDERER_RESOURCE_URI",
    "RESOURCE_MIME_TYPE",
    "RESOURCE_URI_META_KEY",
    "UI_META_KEY",
    "VISIBILITY_META_KEY",
    "ActionEffects",
    "AttachOptions",
    "IntentToolDef",
    "IntentToolSource",
    "IntentToolsOptions",
    "McpErrorInfo",
    "McpFixationsApi",
    "McpHostDeps",
    "ToolVisibility",
    "attach_kohaku_to_mcp_server",
    "inject_snapshot",
    "intent_tools_from_catalog",
    "object_schema_to_json_schema",
    "resource_ui_meta",
    "spec_to_text",
    "tool_ui_meta",
    "to_mcp_tool_name",
]

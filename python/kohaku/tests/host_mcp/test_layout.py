"""Task 6 (mechanical file-layout split): asserts the public import surface of kohaku.host_mcp is unchanged
after server.py was split into types.py / initial_data.py / cache_hints.py, and that tools/list ordering
(part of the wire contract) is unaffected.

Reuses test_mcp.py's TestResourceAndDeclarations.test_tools_list_has_ttl_and_cache_scope pattern (same
`connect` / deps / options helpers) for the ordering assertion, rather than the ttl/cache_scope shape it
itself checks.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from kohaku.host_mcp import AttachOptions, McpHostDeps

from ._helpers import RENDERER_HTML_PLAIN, SimpleAuthz, TrendDomain, connect, make_compose_ctx


def test_public_import_surface_unchanged() -> None:
    """Every name importable from kohaku.host_mcp before Task 6's file split is still importable from there,
    under the same name (server.py now re-exports/delegates to types.py / initial_data.py / cache_hints.py
    internally, but the package's own public surface — what `from kohaku.host_mcp import ...` exposes — is
    unaffected)."""
    from kohaku.host_mcp import (
        CAPABILITY_META_KEY,
        INITIAL_DATA_BUDGET_CHARS,
        INITIAL_DATA_META_KEY,
        RENDERER_RESOURCE_URI,
        RESOURCE_MIME_TYPE,
        RESOURCE_URI_META_KEY,
        UI_META_KEY,
        VISIBILITY_META_KEY,
        ActionEffects,
        AttachOptions,
        IntentToolDef,
        IntentToolsOptions,
        IntentToolSource,
        McpErrorInfo,
        McpFixationsApi,
        McpHostDeps,
        ToolVisibility,
        attach_kohaku_to_mcp_server,
        inject_snapshot,
        intent_tools_from_catalog,
        object_schema_to_json_schema,
        resource_ui_meta,
        spec_to_text,
        to_mcp_tool_name,
        tool_ui_meta,
    )

    # A representative sample is constructible / callable, not just importable (catches a re-export that
    # resolves to the wrong object).
    assert AttachOptions(renderer_html="<html></html>").renderer_html == "<html></html>"
    assert McpErrorInfo(endpoint="x", error=RuntimeError("y")).endpoint == "x"
    assert ActionEffects().invalidates is None
    assert McpFixationsApi is not None
    assert callable(attach_kohaku_to_mcp_server)
    assert callable(inject_snapshot)
    assert callable(spec_to_text)
    assert callable(resource_ui_meta)
    assert callable(tool_ui_meta)
    assert callable(intent_tools_from_catalog)
    assert callable(object_schema_to_json_schema)
    assert callable(to_mcp_tool_name)
    assert IntentToolsOptions().name_prefix is None
    assert INITIAL_DATA_BUDGET_CHARS == 100_000
    assert CAPABILITY_META_KEY and INITIAL_DATA_META_KEY and RENDERER_RESOURCE_URI and RESOURCE_MIME_TYPE
    assert RESOURCE_URI_META_KEY and UI_META_KEY and VISIBILITY_META_KEY
    assert IntentToolDef is not None
    assert IntentToolSource is not None
    assert ToolVisibility is not None
    assert McpHostDeps is not None


def test_tools_list_ordering_unchanged(tmp_path: Path) -> None:
    """tools/list order is part of the wire contract (deterministic = registration order) and must survive
    the file split unchanged: kohaku_compose, kohaku_resolve_binding, kohaku_event, kohaku_action (no
    intent_tools / snapshot_writer wired, same as test_mcp.py's default `_OPTIONS`)."""

    async def run() -> None:
        deps = McpHostDeps(
            compose=make_compose_ctx(tmp_path),
            domain=TrendDomain(),
            authz=SimpleAuthz(),
            query_source="sales",
        )
        options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
        async with connect(deps, options) as client:
            result = await client.list_tools()
            names = [tool.name for tool in result.tools]
            assert names == [
                "kohaku_compose",
                "kohaku_resolve_binding",
                "kohaku_event",
                "kohaku_action",
            ]

    asyncio.run(run())

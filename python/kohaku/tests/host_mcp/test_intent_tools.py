"""Generation / registration / routing of the MCP intent tools from the Intent catalog.

pytest-ification of TS packages/host-mcp-apps/test/intent-tools.test.ts. Verifies that, since Python's SDK does not
fill defaults, to_intent (params.parse) fills them (an intentional difference from TS).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from kohaku.host_mcp import (
    RENDERER_RESOURCE_URI,
    RESOURCE_URI_META_KEY,
    UI_META_KEY,
    VISIBILITY_META_KEY,
    AttachOptions,
    IntentToolsOptions,
    IntentToolSource,
    McpHostDeps,
    intent_tools_from_catalog,
    to_mcp_tool_name,
)
from kohaku.intents import EnumField, number, object_schema, string
from kohaku.spec import IntentInput, parse_spec

from ._helpers import RENDERER_HTML_PLAIN, SimpleAuthz, TrendDomain, connect, make_compose_ctx

REF = "query://sales/summary?fy=2026&groupBy=region"

# Generic views (a minimal form mimicking sample-api's IntentDef).
DEFS: list[IntentToolSource] = [
    IntentToolSource(
        name="sales.quarterly_summary",
        description="Aggregate and display the specified quarter's sales by region / product / channel",
        params=object_schema(
            {
                "fiscalYear": number(integer=True, minimum=2025, maximum=2026).default(2026),
                "quarter": number(integer=True, minimum=1, maximum=4).default(3),
                "groupBy": EnumField(values=("region", "product", "channel")).default("region"),
            }
        ),
    ),
    IntentToolSource(
        name="sales.kpi_overview",
        description="Display this quarter's summary KPIs as cards",
        params=object_schema({"fiscalYear": number(integer=True).default(2026)}),
    ),
]


class TestToMcpToolName:
    def test_folds_dots(self) -> None:
        assert to_mcp_tool_name("sales.quarterly_summary") == "sales_quarterly_summary"

    def test_already_legal(self) -> None:
        assert to_mcp_tool_name("sales_records") == "sales_records"

    def test_folds_runs_and_trims_edges(self) -> None:
        assert to_mcp_tool_name(".a..b.") == "a_b"

    def test_name_prefix(self) -> None:
        assert to_mcp_tool_name("sales.trend", "kohaku") == "kohaku_sales_trend"


class TestIntentToolsFromCatalog:
    def test_maps_name_description_schema_and_to_intent(self) -> None:
        tools = intent_tools_from_catalog(DEFS)
        assert [t.name for t in tools] == ["sales_quarterly_summary", "sales_kpi_overview"]

        summary = tools[0]
        assert "quarter" in summary.description
        # input_schema is JSON Schema (properties / enum / default are reflected).
        props = summary.input_schema["properties"]
        assert list(props.keys()) == ["fiscalYear", "quarter", "groupBy"]
        assert props["groupBy"]["enum"] == ["region", "product", "channel"]
        assert props["fiscalYear"]["default"] == 2026
        # required is only fields that are not default/optional (here all have defaults -> empty).
        assert "required" not in summary.input_schema
        # to_intent keeps canonical as-is and fills, via parse, the defaults Python's SDK does not fill
        # (in TS the SDK's zod fills them so to_intent passes through, but in Python parse is the sole coerce point).
        assert summary.to_intent({"fiscalYear": 2026}) == IntentInput(
            canonical="sales.quarterly_summary",
            params={"fiscalYear": 2026, "quarter": 3, "groupBy": "region"},
        )

    def test_name_prefix_option(self) -> None:
        tools = intent_tools_from_catalog(DEFS, IntentToolsOptions(name_prefix="kohaku"))
        assert [t.name for t in tools] == [
            "kohaku_sales_quarterly_summary",
            "kohaku_sales_kpi_overview",
        ]

    def test_collision_raises_error(self) -> None:
        conflicting = [
            IntentToolSource(name="sales.foo", description="a", params=object_schema({})),
            IntentToolSource(name="sales_foo", description="b", params=object_schema({})),
        ]
        with pytest.raises(ValueError, match="collides"):
            intent_tools_from_catalog(conflicting)

    def test_empty_normalized_name_raises(self) -> None:
        empty = [IntentToolSource(name="...", description="a", params=object_schema({}))]
        with pytest.raises(ValueError, match="valid MCP tool name"):
            intent_tools_from_catalog(empty)

    def test_string_field_required_when_no_default(self) -> None:
        source = IntentToolSource(
            name="sales.search", description="Search", params=object_schema({"q": string()})
        )
        tool = intent_tools_from_catalog([source])[0]
        assert tool.input_schema["required"] == ["q"]


def _intent_deps(tmp_path: Path) -> McpHostDeps:
    return McpHostDeps(
        compose=make_compose_ctx(tmp_path, canonical="sales.quarterly_summary", ref=REF),
        domain=TrendDomain(),
        authz=SimpleAuthz(),
        query_source="sales",
    )


class TestIntentToolRegistrationAndRouting:
    def test_intent_tools_registered_as_model_visible(self, tmp_path: Path) -> None:
        """Every Intent is registered as a model-visible typed tool with a resourceUri."""

        async def run() -> None:
            options = AttachOptions(
                renderer_html=RENDERER_HTML_PLAIN, intent_tools=intent_tools_from_catalog(DEFS)
            )
            async with connect(_intent_deps(tmp_path), options) as client:
                tools = (await client.list_tools()).tools
                by_name = {t.name: t for t in tools}
                for name in ["sales_quarterly_summary", "sales_kpi_overview"]:
                    tool = by_name.get(name)
                    assert tool is not None, name
                    assert tool.meta is not None
                    assert tool.meta[RESOURCE_URI_META_KEY] == RENDERER_RESOURCE_URI
                    assert tool.meta[VISIBILITY_META_KEY] == ["model"]
                    assert tool.meta[UI_META_KEY] == {
                        "resourceUri": RENDERER_RESOURCE_URI,
                        "visibility": ["model"],
                    }

                # input_schema reflects the zod-equivalent enum / default.
                summary = by_name["sales_quarterly_summary"]
                schema_props = summary.input_schema["properties"]
                assert schema_props["groupBy"]["enum"] == ["region", "product", "channel"]
                assert schema_props["fiscalYear"]["default"] == 2026

        asyncio.run(run())

    def test_tools_list_order_is_deterministic(self, tmp_path: Path) -> None:
        """MCP 2026-07-28 (changelog minor #3): tools/list order is fixed tools first, then intent tools in
        catalog order (pytest-ification of TS mcp.test.ts's equivalent). registered (server.py) is a plain
        Python list built in registration order and tools_list is derived from it verbatim, so this ordering
        is stable across repeated tools/list calls and across process restarts."""

        async def run() -> None:
            options = AttachOptions(
                renderer_html=RENDERER_HTML_PLAIN, intent_tools=intent_tools_from_catalog(DEFS)
            )
            async with connect(_intent_deps(tmp_path), options) as client:
                tools = (await client.list_tools()).tools
                assert [t.name for t in tools] == [
                    "kohaku_compose",
                    "sales_quarterly_summary",
                    "sales_kpi_overview",
                    "kohaku_resolve_binding",
                    "kohaku_event",
                    "kohaku_action",
                ]
                # Calling again returns the exact same order (no per-call reshuffling).
                again = (await client.list_tools()).tools
                assert [t.name for t in again] == [t.name for t in tools]

        asyncio.run(run())

    def test_routing_and_default_fill(self, tmp_path: Path) -> None:
        """Tool execution routes to the canonical Intent and defaults are filled."""

        async def run() -> None:
            options = AttachOptions(
                renderer_html=RENDERER_HTML_PLAIN, intent_tools=intent_tools_from_catalog(DEFS)
            )
            async with connect(_intent_deps(tmp_path), options) as client:
                result = await client.call_tool("sales_kpi_overview", {})
                assert not result.is_error
                structured = result.structured_content
                assert structured is not None
                spec = parse_spec(structured["spec"])
                # toMcpToolName changes the name, but the Intent arrives with canonical unchanged.
                assert spec.intent.canonical == "sales.kpi_overview"
                # to_intent's params.parse fills the default.
                assert spec.intent.params["fiscalYear"] == 2026
                # The text fallback is also preserved.
                content = result.content[0]
                assert content.type == "text"
                assert len(content.text) > 0

        asyncio.run(run())

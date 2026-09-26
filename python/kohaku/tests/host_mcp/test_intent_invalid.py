"""A directly-specified Intent that fails SemanticPort.validate_intent must surface as a structured tool error
(is_error, a client-safe message), not an unhandled exception, when the wired SemanticPort implements
validate_intent and rejects it. Covers both MCP entry points that funnel a directly-specified Intent through
host-core's resolve_intent: a generated intent tool (compose-family "intent" ComposeSource) and kohaku_event's
freely-typed `intent` argument (the pre-event `current`). Port of
packages/host-mcp-apps/test/intent-invalid.test.ts.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_mcp import AttachOptions, IntentToolSource, McpHostDeps, intent_tools_from_catalog
from kohaku.intents import object_schema, string
from kohaku.llm import FakeLlm
from kohaku.spec import (
    GuiAction,
    Intent,
    IntentInput,
    IntentValidationError,
    IntentValidationIssue,
    QueryHandle,
    SemanticInput,
    SessionContext,
)
from kohaku.storage import FileStoragePort

from ._helpers import (
    CATALOG,
    RENDERER_HTML_PLAIN,
    SimpleAuthz,
    TrendDomain,
    _fixed_source,
    connect,
    trend_spec_builder,
)

REF = "query://sales/trend?granularity=month&metric=revenue"


class ValidatingSemantic:
    """Only "sales.trend" / "sales.quarterly_summary" with groupBy in {region, product, channel} validates."""

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        if isinstance(input, GuiAction):
            base = dict(input.current.params) if input.current is not None else {}
            canonical = input.current.canonical if input.current is not None else "sales.trend"
            return IntentInput(canonical=canonical, params={**base, **input.params})
        return IntentInput(canonical="sales.trend", params={})

    async def resolve_query(self, intent: Intent, *, tenant: str | None = None) -> QueryHandle:
        return QueryHandle(uri=REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@seed-1"

    async def describe_shape(self, handle: QueryHandle) -> None:
        return None

    async def validate_intent(self, intent: IntentInput, ctx: SessionContext) -> IntentInput:
        if intent.canonical not in ("sales.trend", "sales.quarterly_summary"):
            raise IntentValidationError(f'unknown intent "{intent.canonical}"')
        group_by = intent.params.get("groupBy", "region")
        if group_by not in ("region", "product", "channel"):
            message = 'param "groupBy": expected one of region, product, channel'
            raise IntentValidationError(message, [IntentValidationIssue(path="groupBy", message=message)])
        return IntentInput(canonical=intent.canonical, params={**intent.params, "groupBy": group_by})


def _deps(tmp_path: Path) -> McpHostDeps:
    ctx = ComposeContext(
        catalog=CATALOG,
        semantic=ValidatingSemantic(),
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(),
        policy=ComposePolicy(fixedSpecs=_fixed_source(trend_spec_builder)),
    )
    return McpHostDeps(compose=ctx, domain=TrendDomain(), authz=SimpleAuthz(), query_source="sales")


# The registered tool's own input_schema deliberately uses a bare string() (not an enum) for groupBy, so an
# invalid value is not already rejected at the MCP protocol layer -- the point of this test is that
# validate_intent (a business-rule check the static schema cannot express) still catches it.
DEFS: list[IntentToolSource] = [
    IntentToolSource(
        name="sales.quarterly_summary",
        description="Aggregate the sales for the given quarter by region/product/channel",
        params=object_schema({"groupBy": string().default("region")}),
    ),
]


class TestAGeneratedIntentToolCallWithAnInvalidParam:
    def test_is_a_structured_tool_error_not_a_thrown_exception(self, tmp_path: Path) -> None:
        async def run() -> None:
            options = AttachOptions(
                renderer_html=RENDERER_HTML_PLAIN, intent_tools=intent_tools_from_catalog(DEFS)
            )
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool("sales_quarterly_summary", {"groupBy": "bogus"})
                assert result.is_error
                content = result.content[0]
                assert content.type == "text"
                assert "groupBy" in content.text

        asyncio.run(run())

    def test_a_valid_param_still_composes_normally(self, tmp_path: Path) -> None:
        async def run() -> None:
            options = AttachOptions(
                renderer_html=RENDERER_HTML_PLAIN, intent_tools=intent_tools_from_catalog(DEFS)
            )
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool("sales_quarterly_summary", {"groupBy": "product"})
                assert not result.is_error

        asyncio.run(run())


class TestKohakuEventWithAnInvalidDirectlySpecifiedIntent:
    def test_an_unknown_canonical_is_a_structured_tool_error(self, tmp_path: Path) -> None:
        async def run() -> None:
            options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.bogus", "params": {}},
                        "on": "table1.sort",
                        "payload": {},
                    },
                )
                assert result.is_error
                content = result.content[0]
                assert content.type == "text"
                assert 'unknown intent "sales.bogus"' in content.text

        asyncio.run(run())

    def test_an_invalid_param_is_a_structured_tool_error(self, tmp_path: Path) -> None:
        async def run() -> None:
            options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {"groupBy": "bogus"}},
                        "on": "table1.sort",
                        "payload": {},
                    },
                )
                assert result.is_error
                content = result.content[0]
                assert content.type == "text"
                assert "groupBy" in content.text

        asyncio.run(run())

    def test_a_valid_intent_still_recomposes_normally(self, tmp_path: Path) -> None:
        async def run() -> None:
            options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {"groupBy": "region"}},
                        "on": "table1.sort",
                        "payload": {},
                    },
                )
                assert not result.is_error

        asyncio.run(run())

"""The shared `locale` tool argument (mirrors TS host-mcp-apps/test/locale.test.ts).

The calling LLM sets the user's language per call; it rides SessionContext.locale into NL
normalize, the fixation gate, and ComposeContext.policyFor — the same knob the REST profile
carries as session.locale.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_mcp import AttachOptions, McpHostDeps, attach_kohaku_to_mcp_server
from kohaku.host_mcp.intent_tools import IntentToolDef
from kohaku.llm import FakeLlm
from kohaku.spec import (
    FixationRecord,
    Intent,
    IntentInput,
    JsonObject,
    QueryHandle,
    SessionContext,
    UISpec,
    parse_spec,
)

from ._helpers import (
    CATALOG,
    RENDERER_HTML_PLAIN,
    SimpleAuthz,
    TrendDomain,
    _fixed_source,
    connect,
    trend_spec_builder,
)

try:
    from mcp.server.lowlevel.server import Server
except ImportError:  # pragma: no cover
    pytest.skip("mcp is not installed", allow_module_level=True)


def _ja_spec_builder(intent_arg: Intent, handles: list[QueryHandle]) -> UISpec:
    spec = trend_spec_builder(intent_arg, handles)
    wire = spec.to_wire()
    wire["components"][1]["props"]["text"] = "月次売上の推移"
    return UISpec.model_validate(wire)


class _CapturingSemantic:
    """Deterministic SemanticPort that records the SessionContext of each normalize call."""

    def __init__(self) -> None:
        self.sessions: list[SessionContext] = []

    async def normalize(self, input: Any, ctx: SessionContext) -> IntentInput:
        self.sessions.append(ctx)
        return IntentInput(canonical="sales.trend", params={})

    async def resolve_query(self, intent: Intent, *, tenant: str | None = None) -> QueryHandle:
        return QueryHandle(uri="query://sales/trend?granularity=month&metric=revenue")

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@seed-1"

    async def describe_shape(self, handle: QueryHandle) -> None:
        return None


def _make_lang_ctx(tmp_path: Path) -> tuple[ComposeContext, _CapturingSemantic]:
    from kohaku.storage import FileStoragePort

    semantic = _CapturingSemantic()
    policy_by_lang = {
        "en": ComposePolicy(fixedSpecs=_fixed_source(trend_spec_builder), generatorVersion="t"),
        "ja": ComposePolicy(fixedSpecs=_fixed_source(_ja_spec_builder), generatorVersion="t/ja"),
    }
    ctx = ComposeContext(
        catalog=CATALOG,
        semantic=semantic,
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(),
        policy=policy_by_lang["en"],
        policyFor=lambda session: policy_by_lang[
            "ja" if session is not None and session.locale == "ja" else "en"
        ],
    )
    return ctx, semantic


def _deps(ctx: ComposeContext, **overrides: Any) -> McpHostDeps:
    base: dict[str, Any] = {
        "compose": ctx,
        "domain": TrendDomain(),
        "authz": SimpleAuthz(),
        "query_source": "sales",
    }
    base.update(overrides)
    return McpHostDeps(**base)


_OPTIONS = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)


def _heading_of(result: Any) -> str:
    spec = parse_spec(result.structuredContent["spec"])
    for component in spec.components:
        if component.type == "text.heading":
            return str((component.props or {}).get("text", ""))
    return ""


class TestComposeLocale:
    def test_locale_ja_selects_ja_policy_and_reaches_normalize(self, tmp_path: Path) -> None:
        async def run() -> None:
            ctx, semantic = _make_lang_ctx(tmp_path)
            async with connect(_deps(ctx), _OPTIONS) as client:
                ja = await client.call_tool(
                    "kohaku_compose", {"question": "売上の月次推移", "locale": "ja"}
                )
                assert _heading_of(ja) == "月次売上の推移"
                en = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert _heading_of(en) == "Monthly sales trend"
                assert semantic.sessions[0].surface == "mcp-app"
                assert semantic.sessions[0].locale == "ja"
                assert semantic.sessions[1].locale is None

        asyncio.run(run())


class TestIntentToolLocale:
    def test_locale_is_applied_and_stripped_from_intent_params(self, tmp_path: Path) -> None:
        captured: list[JsonObject] = []

        def to_intent(args: JsonObject) -> IntentInput:
            captured.append(args)
            return IntentInput(canonical="sales.trend", params=args)

        tool = IntentToolDef(
            name="sales_trend",
            description="trend",
            input_schema={
                "type": "object",
                "properties": {"metric": {"type": "string"}},
                "required": [],
            },
            to_intent=to_intent,
        )

        async def run() -> None:
            ctx, _ = _make_lang_ctx(tmp_path)
            options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN, intent_tools=[tool])
            async with connect(_deps(ctx), options) as client:
                result = await client.call_tool(
                    "sales_trend", {"metric": "revenue", "locale": "ja"}
                )
                assert _heading_of(result) == "月次売上の推移"
                # The reserved argument must not pollute the canonical intent params.
                assert captured[0] == {"metric": "revenue"}
                # The declared inputSchema advertises the shared locale property.
                tools = (await client.list_tools()).tools
                trend = next(t for t in tools if t.name == "sales_trend")
                assert "locale" in trend.inputSchema["properties"]

        asyncio.run(run())

    def test_reserved_locale_param_is_rejected_at_attach_time(self, tmp_path: Path) -> None:
        ctx, _ = _make_lang_ctx(tmp_path)
        tool = IntentToolDef(
            name="bad_tool",
            description="declares the reserved param",
            input_schema={
                "type": "object",
                "properties": {"locale": {"type": "string"}},
                "required": [],
            },
            to_intent=lambda args: IntentInput(canonical="x", params=args),
        )
        server = Server("kohaku-host-mcp-test")
        with pytest.raises(ValueError, match="reserved"):
            attach_kohaku_to_mcp_server(
                server,
                _deps(ctx),
                AttachOptions(renderer_html=RENDERER_HTML_PLAIN, intent_tools=[tool]),
            )


class TestEventAndFixationLocale:
    def test_event_locale_reaches_normalize_and_recompose_policy(self, tmp_path: Path) -> None:
        async def run() -> None:
            ctx, semantic = _make_lang_ctx(tmp_path)
            async with connect(_deps(ctx), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {}},
                        "on": "c.pointClick",
                        "payload": {},
                        "locale": "ja",
                    },
                )
                assert _heading_of(result) == "月次売上の推移"
                assert semantic.sessions[0].locale == "ja"

        asyncio.run(run())

    def test_fixation_lookup_receives_the_per_call_session(self, tmp_path: Path) -> None:
        seen: list[SessionContext] = []

        async def fixation_lookup(
            intent_hash: str, session: SessionContext
        ) -> FixationRecord | None:
            seen.append(session)
            return None

        async def run() -> None:
            ctx, _ = _make_lang_ctx(tmp_path)
            async with connect(
                _deps(ctx, fixation_lookup=fixation_lookup), _OPTIONS
            ) as client:
                await client.call_tool(
                    "kohaku_compose", {"question": "売上の月次推移", "locale": "ja"}
                )
                assert seen[0].surface == "mcp-app"
                assert seen[0].locale == "ja"

        asyncio.run(run())

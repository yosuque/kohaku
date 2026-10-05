"""When the LLM provider cannot serve Intent resolution (no API key, provider failure, abort), the MCP tool must
answer a structured tool error carrying the fixed message -- never the provider SDK's raw wording -- and the
original LlmError must still reach on_error. Port of packages/host-mcp-apps/test/llm-unavailable.test.ts.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from kohaku.composer import ComposeContext, ComposePolicy
from kohaku.host_core import LLM_PROVIDER_UNAVAILABLE_MESSAGE
from kohaku.host_mcp import AttachOptions, McpErrorInfo, McpHostDeps
from kohaku.llm import FakeLlm, LlmError
from kohaku.spec import Intent, IntentInput, QueryHandle, SemanticInput, SessionContext
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
_RAW_SDK_MESSAGE = (
    "[claude/claude-sonnet-5] Anthropic API key is missing. Pass it using the 'apiKey' parameter "
    "or the ANTHROPIC_API_KEY environment variable."
)


class FailingSemantic:
    """A SemanticPort whose normalize raises `error`."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        raise self._error

    async def resolve_query(self, intent: Intent, *, tenant: str | None = None) -> QueryHandle:
        return QueryHandle(uri=REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@seed-1"

    async def describe_shape(self, handle: QueryHandle) -> None:
        return None


def _deps(tmp_path: Path, error: Exception, seen: list[McpErrorInfo]) -> McpHostDeps:
    ctx = ComposeContext(
        catalog=CATALOG,
        semantic=FailingSemantic(error),
        storage=FileStoragePort(tmp_path),
        llm=FakeLlm(),
        policy=ComposePolicy(fixedSpecs=_fixed_source(trend_spec_builder)),
    )
    return McpHostDeps(
        compose=ctx,
        domain=TrendDomain(),
        authz=SimpleAuthz(),
        query_source="sales",
        on_error=lambda info: seen.append(info),
    )


@pytest.mark.parametrize("code", ["PROVIDER", "CONFIG", "ABORTED"])
def test_kohaku_compose_nl_returns_the_fixed_message_and_reports_the_original_error(
    tmp_path: Path, code: str
) -> None:
    error = LlmError(code, _RAW_SDK_MESSAGE)  # type: ignore[arg-type]
    seen: list[McpErrorInfo] = []

    async def run() -> None:
        options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
        async with connect(_deps(tmp_path, error, seen), options) as client:
            result = await client.call_tool("kohaku_compose", {"question": "Monthly revenue trend"})
            assert result.is_error
            content = result.content[0]
            assert content.type == "text"
            assert content.text == LLM_PROVIDER_UNAVAILABLE_MESSAGE
            assert "API key" not in content.text

    asyncio.run(run())
    assert [info.error for info in seen] == [error]


def test_llm_error_invalid_output_does_not_leak_its_raw_wording(tmp_path: Path) -> None:
    seen: list[McpErrorInfo] = []

    async def run() -> None:
        options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
        deps = _deps(tmp_path, LlmError("INVALID_OUTPUT", _RAW_SDK_MESSAGE), seen)
        async with connect(deps, options) as client:
            result = await client.call_tool("kohaku_compose", {"question": "Monthly revenue trend"})
            assert result.is_error
            content = result.content[0]
            assert content.type == "text"
            assert "API key" not in content.text
            assert content.text != LLM_PROVIDER_UNAVAILABLE_MESSAGE

    asyncio.run(run())


def test_a_typed_error_keeps_passing_its_own_message_through(tmp_path: Path) -> None:
    no_match = Exception("no intent matches the question")
    no_match.code = "NO_MATCH"  # type: ignore[attr-defined]
    seen: list[McpErrorInfo] = []

    async def run() -> None:
        options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
        async with connect(_deps(tmp_path, no_match, seen), options) as client:
            result = await client.call_tool("kohaku_compose", {"question": "Monthly revenue trend"})
            assert result.is_error
            content = result.content[0]
            assert content.type == "text"
            assert content.text == "no intent matches the question"

    asyncio.run(run())

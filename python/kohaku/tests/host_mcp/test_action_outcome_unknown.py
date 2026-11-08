"""kohaku_action: a write whose answer never came back (an `*_OUTCOME_UNKNOWN` code) answers host_core's fixed
OUTCOME_UNKNOWN_MESSAGE as a structured tool error, and the real error still reaches on_error. Any other failed
write keeps the generic internal-error message. Port of packages/host-mcp-apps/test/action-outcome-unknown.test.ts.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from kohaku.composer import ComposeContext
from kohaku.host_core import OUTCOME_UNKNOWN_MESSAGE
from kohaku.host_mcp import AttachOptions, McpErrorInfo, McpHostDeps
from kohaku.llm import FakeLlm
from kohaku.spec import InvocationContext, JsonObject, OperationDescriptor
from kohaku.storage import FileStoragePort

from ._helpers import CATALOG, RENDERER_HTML_PLAIN, SimpleAuthz, connect
from .test_llm_unavailable import FailingSemantic


class _FailingDomain:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def list_operations(self) -> list[OperationDescriptor]:
        return [OperationDescriptor(name="annotate", description="d")]

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        raise self._error


def _deps(tmp_path: Path, error: Exception, seen: list[McpErrorInfo]) -> McpHostDeps:
    return McpHostDeps(
        compose=ComposeContext(
            catalog=CATALOG,
            semantic=FailingSemantic(RuntimeError("unused")),
            storage=FileStoragePort(tmp_path),
            llm=FakeLlm(),
        ),
        domain=_FailingDomain(error),
        authz=SimpleAuthz(),
        query_source="sales",
        on_error=lambda info: seen.append(info),
    )


async def _call_action(deps: McpHostDeps) -> Any:
    options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
    async with connect(deps, options) as client:
        return await client.call_tool(
            "kohaku_action",
            {"action": "annotate", "payload": {}, "capability": "cap:annotate"},
        )


def test_answers_the_fixed_outcome_unknown_message_and_reports_the_original_error(
    tmp_path: Path,
) -> None:
    timed_out = RuntimeError('MCP tool "annotate": did not answer in time; its effect is unknown')
    timed_out.code = "MCP_OUTCOME_UNKNOWN"  # type: ignore[attr-defined]
    seen: list[McpErrorInfo] = []
    result = asyncio.run(_call_action(_deps(tmp_path, timed_out, seen)))
    assert result.is_error
    assert result.content[0].text == OUTCOME_UNKNOWN_MESSAGE
    assert [i.error for i in seen if i.endpoint == "kohaku_action"] == [timed_out]


def test_keeps_the_generic_message_for_any_other_failed_write(tmp_path: Path) -> None:
    seen: list[McpErrorInfo] = []
    result = asyncio.run(_call_action(_deps(tmp_path, RuntimeError("write failed (test)"), seen)))
    assert result.is_error
    assert (
        result.content[0].text
        == "internal error; see the observability hook (on_error) for details"
    )

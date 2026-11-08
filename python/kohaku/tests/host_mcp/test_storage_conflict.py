"""A StorageConflictError (a StoragePort compare-and-set that lost a race with another host instance) reaching
a tool boundary must answer a structured tool error carrying the fixed STORAGE_CONFLICT_MESSAGE -- never the
error's own text (which names the record kind and key) -- and the original error must still reach on_error.
Port of packages/host-mcp-apps/test/storage-conflict.test.ts.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from kohaku.host_core import STORAGE_CONFLICT_MESSAGE
from kohaku.host_mcp import AttachOptions, McpErrorInfo
from kohaku.spec import StorageConflictError

from ._helpers import RENDERER_HTML_PLAIN, connect
from .test_llm_unavailable import _deps


def test_kohaku_compose_answers_the_fixed_conflict_message_and_reports_the_original_error(
    tmp_path: Path,
) -> None:
    error = StorageConflictError("fixation", "intent-secret-hash")
    seen: list[McpErrorInfo] = []

    async def run() -> None:
        options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)
        async with connect(_deps(tmp_path, error, seen), options) as client:
            result = await client.call_tool("kohaku_compose", {"question": "Monthly revenue trend"})
            assert result.is_error
            content = result.content[0]
            assert content.type == "text"
            assert content.text == STORAGE_CONFLICT_MESSAGE
            assert "secret" not in content.text

    asyncio.run(run())
    assert [info.error for info in seen] == [error]

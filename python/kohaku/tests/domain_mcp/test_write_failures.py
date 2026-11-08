"""A write that fails after the request may have left is outcome-unknown (port of write-failures.test.ts)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kohaku.domain_mcp import (
    MCP_OUTCOME_UNKNOWN,
    McpOutcomeUnknownError,
    create_mcp_domain_port,
)
from kohaku.spec import InvocationContext, Principal

from ._fakes import LIST_ORDERS, REFUND_ORDER, FakeListResult, FakeResult

CTX = InvocationContext(principal=Principal(id="u1", roles=[]))


class RpcError(Exception):
    """Shaped like the SDK's MCPError: an int `code` (JSON-RPC)."""

    def __init__(self, code: int, message: str = "rpc") -> None:
        super().__init__(message)
        self.code = code


class Failing:
    def __init__(self, error: BaseException) -> None:
        self._error = error

    async def list_tools(self, *, cursor: str | None = None) -> FakeListResult:
        return FakeListResult(tools=[LIST_ORDERS, REFUND_ORDER])

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: float | None = None,
    ) -> FakeResult:
        raise self._error


async def _fail(tool: str, error: BaseException) -> BaseException:
    port = await create_mcp_domain_port(client=Failing(error), call_timeout_ms=1000)
    args: dict[str, Any] = {"orderId": "o-1"} if tool == "refund_order" else {}
    try:
        await port.invoke(tool, args, CTX)
    except BaseException as caught:  # noqa: BLE001
        return caught
    raise AssertionError("expected a failure")


@pytest.mark.parametrize("code", [-32000, -32001])
def test_wraps_the_sdk_local_connection_closed_and_request_timeout(code: int) -> None:
    original = RpcError(code, "Connection closed")
    failure = asyncio.run(_fail("refund_order", original))
    assert isinstance(failure, McpOutcomeUnknownError)
    assert failure.code == MCP_OUTCOME_UNKNOWN
    assert failure.__cause__ is original
    # The SDK's own wording is for the operator (on_error), not the message of the wrapper.
    assert "Connection closed" not in str(failure)


@pytest.mark.parametrize(
    "original",
    [ConnectionResetError("reset"), OSError("transport"), RuntimeError("boom")],
    ids=lambda e: type(e).__name__,
)
def test_wraps_a_transport_error_and_an_unknown_shape(original: Exception) -> None:
    failure = asyncio.run(_fail("refund_order", original))
    assert isinstance(failure, McpOutcomeUnknownError)
    assert failure.__cause__ is original


@pytest.mark.parametrize("code", [-32602, -32601, -32603, 400])
def test_re_raises_a_json_rpc_error_the_server_answered_unchanged(code: int) -> None:
    original = RpcError(code)
    assert asyncio.run(_fail("refund_order", original)) is original


def test_leaves_a_reads_failure_alone() -> None:
    original = RpcError(-32000, "Connection closed")
    assert asyncio.run(_fail("list_orders", original)) is original


def test_a_client_side_timeout_error_on_a_write_is_outcome_unknown_too() -> None:
    from kohaku.domain_mcp import McpTimeoutError

    failure = asyncio.run(_fail("refund_order", TimeoutError()))
    assert isinstance(failure, McpTimeoutError)
    assert failure.code == MCP_OUTCOME_UNKNOWN

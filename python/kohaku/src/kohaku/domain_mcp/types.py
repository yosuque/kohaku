"""The slice of the MCP SDK this package reads (port of types.ts).

Structural on purpose, like the TS side: nothing here imports `mcp`, so importing `kohaku.domain_mcp` works without
the `mcp` extra. The official SDK's `Client`, `Tool` and `CallToolResult` (attribute names `input_schema`,
`output_schema`, `annotations.read_only_hint`, `structured_content`, `is_error`, `content`, `next_cursor`) satisfy
these protocols, and so does any plain dataclass with the same attributes.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol


class McpToolAnnotationsLike(Protocol):
    @property
    def read_only_hint(self) -> bool | None: ...


class McpToolInfo(Protocol):
    """A tool as listed by the server (TS `McpToolInfo`)."""

    @property
    def name(self) -> str: ...

    @property
    def title(self) -> str | None: ...

    @property
    def description(self) -> str | None: ...

    @property
    def input_schema(self) -> dict[str, Any]: ...

    @property
    def output_schema(self) -> dict[str, Any] | None: ...

    @property
    def annotations(self) -> McpToolAnnotationsLike | None: ...


class McpCallResult(Protocol):
    """A tool call result (TS `McpCallResult`). Each `content` block has `.type` and, for text, `.text`."""

    @property
    def content(self) -> Sequence[Any]: ...

    @property
    def structured_content(self) -> Any: ...

    @property
    def is_error(self) -> bool: ...


class McpListToolsResultLike(Protocol):
    @property
    def tools(self) -> Sequence[McpToolInfo]: ...

    @property
    def next_cursor(self) -> str | None: ...


class McpToolClientLike(Protocol):
    """The slice of the MCP client this package calls: the SDK's `Client` satisfies it."""

    async def list_tools(self, *, cursor: str | None = None) -> McpListToolsResultLike: ...

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: float | None = None,
    ) -> McpCallResult:
        """`read_timeout_seconds` is the SDK's own per-call deadline (the Python twin of the TS `timeout`)."""
        ...

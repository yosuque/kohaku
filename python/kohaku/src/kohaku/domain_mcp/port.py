"""A kohaku `DomainPort` over an existing MCP server (port of port.ts).

A tool with `annotations.read_only_hint is True` is a query (`query://` ref -> `TabularData`); every other tool is
an `approve`-tier governed Action. See `create_mcp_domain_port`.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from kohaku.spec import (
    ActionTier,
    DataShape,
    InvocationContext,
    JsonObject,
    OperationDescriptor,
    QueryRef,
)

from .coerce import coerce_tool_arguments
from .data_version import mcp_data_version
from .schema_projection import SchemaProjection, project_input_schema
from .shape import shape_from_output_schema
from .tabular import assert_tool_succeeded, payload_of, to_tabular_data
from .types import McpCallResult, McpToolClientLike, McpToolInfo

# The names an MCP tool may have (SEP-986), which is also what a `query://` path segment can carry verbatim.
_TOOL_NAME_PATTERN = re.compile(r"[A-Za-z0-9_.-]{1,128}")

# A guard against a server that pages forever.
_MAX_LIST_PAGES = 100


@dataclass(frozen=True)
class SchemaProjectionReport:
    """What `on_schema_projection` receives (TS `{ tool, dropped, omitted, reasons }`)."""

    tool: str
    dropped: list[str]
    omitted: bool
    reasons: list[str]


@dataclass(frozen=True)
class SkipReport:
    """What `on_skip` receives (TS `{ tool, reason }`)."""

    tool: str
    reason: str


async def _list_all_tools(client: McpToolClientLike) -> list[McpToolInfo]:
    tools: list[McpToolInfo] = []
    cursor: str | None = None
    for _ in range(_MAX_LIST_PAGES):
        result = await client.list_tools(cursor=cursor)
        tools.extend(result.tools)
        if result.next_cursor is None or result.next_cursor == "":
            return tools
        cursor = result.next_cursor
    raise RuntimeError(
        f"create_mcp_domain_port: the server's tool list did not end after {_MAX_LIST_PAGES} pages"
    )


def _is_read_only(tool: McpToolInfo) -> bool:
    # MCP's default for readOnlyHint is false, so only an explicit True makes a tool a query: a tool that says
    # nothing is a write, which is the safe side.
    annotations = tool.annotations
    return annotations is not None and annotations.read_only_hint is True


def _first_present(*values: str | None) -> str:
    """TS's `a ?? b ?? c`: the first value that is not None (an empty string counts as present)."""
    for value in values:
        if value is not None:
            return value
    raise ValueError("no value present")


def _describe_operation(
    tool: McpToolInfo, projection: SchemaProjection, tier: ActionTier | None
) -> OperationDescriptor:
    return OperationDescriptor(
        name=tool.name,
        description=_first_present(tool.description, tool.title, tool.name),
        paramsSchema=projection.schema,
        resultShape=shape_from_output_schema(tool.output_schema),
        tier=tier,
    )


def _action_result(payload: object) -> Any:
    """The result of an Action as the JSON object `DomainPort.invoke` hands back to the host."""
    if payload is None:
        return {"ok": True}
    if isinstance(payload, dict):
        return payload
    return {"result": payload}


class McpDomainPort:
    """The `DomainPort` `create_mcp_domain_port` returns."""

    def __init__(
        self,
        *,
        client: McpToolClientLike,
        tools: dict[str, McpToolInfo],
        operations: list[OperationDescriptor],
        query_ops: tuple[str, ...],
        action_ops: tuple[str, ...],
        data_version: Callable[[], str],
    ) -> None:
        self._client = client
        self._operations = operations
        self.tools: Mapping[str, McpToolInfo] = tools
        self.query_ops: Sequence[str] = query_ops
        """Names of the read-only tools (in listing order): the operations a `query://` ref can resolve to."""
        self.action_ops: Sequence[str] = action_ops
        """Names of every other exposed tool (in listing order): the governed Actions."""
        self.data_version = data_version
        """The version stamped on returned data (see `create_mcp_domain_port`'s `data_version`)."""

    async def list_operations(self) -> list[OperationDescriptor]:
        return list(self._operations)

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        tool = self.tools.get(op)
        if tool is None:
            raise ValueError(f'unknown operation "{op}"')
        if op in self.query_ops:
            result: McpCallResult = await self._client.call_tool(
                op, dict(coerce_tool_arguments(args, tool.input_schema))
            )
            return to_tabular_data(result, self.data_version(), op)
        result = await self._client.call_tool(op, dict(args))
        assert_tool_succeeded(result, op)
        return _action_result(payload_of(result))

    def describe_shape(self, ref: QueryRef) -> DataShape | None:
        """The column shape of a query op, from its tool's `outputSchema`; None when it has none or is not a
        query."""
        if ref.path not in self.query_ops:
            return None
        tool = self.tools.get(ref.path)
        return shape_from_output_schema(tool.output_schema) if tool is not None else None


async def create_mcp_domain_port(
    *,
    client: McpToolClientLike,
    include: Callable[[McpToolInfo], bool] | None = None,
    tier_for: Callable[[McpToolInfo], ActionTier] | None = None,
    data_version: Callable[[], str] | None = None,
    on_schema_projection: Callable[[SchemaProjectionReport], None] | None = None,
    on_skip: Callable[[SkipReport], None] | None = None,
) -> McpDomainPort:
    """Build a kohaku `DomainPort` over an existing MCP server. The tool list is read once, here (a later
    `tools/list_changed` is not followed: restart the host to pick up a new tool).

    - A tool with `annotations.read_only_hint is True` is a query: a `query://` ref whose path is the tool name
      resolves by calling it, and the result becomes `TabularData`. It carries no `tier`.
    - Every other tool is an Action with `tier="approve"` (override with `tier_for`). Its `paramsSchema` is the
      projection of its `inputSchema` onto kohaku's closed subset, or absent when that is impossible; the
      approver then judges the raw payload.
    - The calling principal is not forwarded to the MCP server: authenticating to it is the client transport's
      job.

    `include` selects which tools to expose at all (default: every listed tool). `data_version` is stamped on
    every `TabularData` this port returns (default `mcp_data_version()`); pass the same function to the host's
    data version (or read it back from `port.data_version`) so the Spec's version and the data's agree.
    `on_schema_projection` is called once per exposed tool whose projection lost something or was impossible;
    `on_skip` for a listed tool left out because its name is unusable or duplicated.
    """
    version = data_version if data_version is not None else mcp_data_version()
    tools: dict[str, McpToolInfo] = {}
    operations: list[OperationDescriptor] = []
    query_ops: list[str] = []
    action_ops: list[str] = []

    for tool in await _list_all_tools(client):
        if _TOOL_NAME_PATTERN.fullmatch(tool.name) is None:
            if on_skip is not None:
                on_skip(
                    SkipReport(
                        tool=tool.name,
                        reason="the tool name is not usable as a query:// path segment",
                    )
                )
            continue
        if tool.name in tools:
            if on_skip is not None:
                on_skip(
                    SkipReport(tool=tool.name, reason="a tool with this name was already listed")
                )
            continue
        if include is not None and not include(tool):
            continue

        projection = project_input_schema(tool.input_schema)
        if on_schema_projection is not None and (projection.omitted or len(projection.dropped) > 0):
            on_schema_projection(
                SchemaProjectionReport(
                    tool=tool.name,
                    dropped=projection.dropped,
                    omitted=projection.omitted,
                    reasons=projection.reasons,
                )
            )
        tools[tool.name] = tool
        if _is_read_only(tool):
            query_ops.append(tool.name)
            operations.append(_describe_operation(tool, projection, None))
        else:
            action_ops.append(tool.name)
            tier = tier_for(tool) if tier_for is not None else "approve"
            operations.append(_describe_operation(tool, projection, tier))

    return McpDomainPort(
        client=client,
        tools=tools,
        operations=operations,
        query_ops=tuple(query_ops),
        action_ops=tuple(action_ops),
        data_version=version,
    )

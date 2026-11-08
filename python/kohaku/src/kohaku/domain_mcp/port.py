"""A kohaku `DomainPort` over an existing MCP server (port of port.ts).

A tool with `annotations.read_only_hint is True` is a query (`query://` ref -> `TabularData`); every other tool is
an `approve`-tier governed Action. See `create_mcp_domain_port`.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from kohaku.spec import (
    ActionTier,
    DataShape,
    InvocationContext,
    JsonObject,
    OperationDescriptor,
    QueryRef,
)

from .coerce import DEFAULT_MAX_LIMIT, coerce_tool_arguments
from .data_version import mcp_data_version
from .schema_projection import SchemaProjection, dropped_constraints, project_input_schema
from .shape import shape_from_output_schema
from .tabular import (
    DEFAULT_MAX_RESULT_BYTES,
    DEFAULT_MAX_ROWS,
    assert_tool_succeeded,
    payload_of,
    to_tabular_data,
)
from .types import McpCallResult, McpToolClientLike, McpToolInfo

# The names an MCP tool may have (SEP-986), which is also what a `query://` path segment can carry verbatim.
_TOOL_NAME_PATTERN = re.compile(r"[A-Za-z0-9_.-]{1,128}")

# A guard against a server that pages forever.
MAX_LIST_PAGES = 100

# Default deadline for one upstream `tools/call`, in milliseconds.
DEFAULT_CALL_TIMEOUT_MS = 30_000

# The SDK's own timeout is set this much later than ours, as a backstop that never wins the race.
_SDK_TIMEOUT_MARGIN_SECONDS = 5.0

# How many constraint names the approver-facing description lists before it says "…".
_MAX_LISTED_CONSTRAINTS = 5


MCP_OUTCOME_UNKNOWN = "MCP_OUTCOME_UNKNOWN"
"""The `code` of an error that says "the write may have been applied" (host_core's `is_outcome_unknown_error`):
a write's `McpTimeoutError`, and `McpOutcomeUnknownError`."""


class McpTimeoutError(RuntimeError):
    """An upstream call did not answer within `call_timeout_ms`. The request was cancelled, not retried. For a
    write the message says the effect is unknown (the tool may or may not have run) and the error carries the
    code `MCP_OUTCOME_UNKNOWN`, which the hosts recognise: REST answers 503 `INTERNAL` with a fixed "outcome is
    unknown; verify before retrying" message instead of the 404 every failed read gets, and MCP the same text as
    a tool error. A read's timeout has no `code`: nothing was changed, so it stays an ordinary failed read."""

    def __init__(self, tool: str, write: bool) -> None:
        suffix = "; its effect is unknown" if write else ""
        super().__init__(f'MCP tool "{tool}": the upstream tool did not answer in time{suffix}')
        self.code: str | None = MCP_OUTCOME_UNKNOWN if write else None


class McpOutcomeUnknownError(RuntimeError):
    """A write's upstream call failed in a way that does not tell whether the tool ran: the connection closed or
    the send failed after the request may have left, a transport error, or the SDK's own request timeout. Carries
    the code `MCP_OUTCOME_UNKNOWN` like a write's `McpTimeoutError`, and the original error as `__cause__` (the
    hosts show the caller only the fixed message; the cause reaches `on_error`)."""

    def __init__(self, tool: str) -> None:
        super().__init__(
            f'MCP tool "{tool}": the upstream call failed after the request may have been sent; '
            "its effect is unknown"
        )
        self.code: str = MCP_OUTCOME_UNKNOWN


# The Python SDK raises these JSON-RPC-numbered MCPErrors locally (CONNECTION_CLOSED, REQUEST_TIMEOUT): they are
# not answers from the server, so they do not say that the tool did not run.
_SDK_LOCAL_RPC_CODES = frozenset({-32000, -32001})


def _failed_before_execution(error: BaseException) -> bool:
    """Whether a write's failure is one that certainly did not run the tool, so it is re-raised unchanged: a
    JSON-RPC error the server answered (the SDK's `MCPError`, an int `code`) other than the SDK-local
    CONNECTION_CLOSED / REQUEST_TIMEOUT. Every other failure (a transport error, an unknown shape) is treated as
    "may have been applied". Duck-typed, like the TS port: this package never imports the SDK."""
    code = getattr(error, "code", None)
    return isinstance(code, int) and not isinstance(code, bool) and code not in _SDK_LOCAL_RPC_CODES


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
    for _ in range(MAX_LIST_PAGES):
        result = await client.list_tools(cursor=cursor)
        tools.extend(result.tools)
        if result.next_cursor is None or result.next_cursor == "":
            return tools
        cursor = result.next_cursor
    raise RuntimeError(
        f"create_mcp_domain_port: the server's tool list did not end after {MAX_LIST_PAGES} pages"
    )


def _default_is_read_only(tool: McpToolInfo) -> bool:
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


def _describe_action(tool: McpToolInfo, projection: SchemaProjection) -> str:
    """The approver-facing description, with a note when the projection loosened or dropped the payload check."""
    base = _first_present(tool.description, tool.title, tool.name)
    if projection.omitted:
        return f"{base} (parameter schema omitted: the payload is not validated)"
    count, keywords = dropped_constraints(projection.dropped)
    if count == 0:
        return base
    listed = ", ".join(keywords[:_MAX_LISTED_CONSTRAINTS])
    more = ", …" if len(keywords) > _MAX_LISTED_CONSTRAINTS else ""
    plural = "" if count == 1 else "s"
    return f"{base} ({count} schema constraint{plural} omitted: {listed}{more})"


def _describe_operation(
    tool: McpToolInfo, projection: SchemaProjection, tier: ActionTier | None
) -> OperationDescriptor:
    description = (
        _first_present(tool.description, tool.title, tool.name)
        if tier is None
        else _describe_action(tool, projection)
    )
    return OperationDescriptor(
        name=tool.name,
        description=description,
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
        query_names: frozenset[str],
        action_names: frozenset[str],
        data_version: Callable[[], str],
        call_timeout_ms: float,
        max_limit: int | float,
        max_rows: int,
        max_result_bytes: int,
    ) -> None:
        self._client = client
        self._tools = tools
        self._operations = operations
        self._call_timeout_ms = call_timeout_ms
        self._max_limit = max_limit
        self._max_rows = max_rows
        self._max_result_bytes = max_result_bytes
        self.query_ops: frozenset[str] = query_names
        """Names of the read-only tools: the operations a `query://` ref can resolve to."""
        self.action_ops: frozenset[str] = action_names
        """Names of every other exposed tool: the governed Actions."""
        self.data_version = data_version
        """The version stamped on returned data (see `create_mcp_domain_port`'s `data_version`)."""

    @property
    def tools(self) -> Mapping[str, McpToolInfo]:
        """Every exposed tool by name, in listing order (`create_mcp_intents` builds Intent params from it)."""
        return MappingProxyType(self._tools)

    async def list_operations(self) -> list[OperationDescriptor]:
        return list(self._operations)

    async def _call(self, name: str, arguments: dict[str, Any], *, write: bool) -> McpCallResult:
        """One upstream call with a deadline: cancels the request and never retries."""
        seconds = self._call_timeout_ms / 1000
        try:
            return await asyncio.wait_for(
                self._client.call_tool(
                    name, arguments, read_timeout_seconds=seconds + _SDK_TIMEOUT_MARGIN_SECONDS
                ),
                timeout=seconds,
            )
        except TimeoutError:
            # Deliberately broader than the TS port, which has its own timer: `asyncio.wait_for` also lets a
            # TimeoutError the client itself raised (e.g. the SDK's own request timeout) through as this one.
            # Both mean "no answer in time", so a write's is outcome-unknown either way.
            raise McpTimeoutError(name, write) from None
        except Exception as error:
            # (CancelledError is a BaseException and passes through.) A write that fails in a way that does not
            # tell whether the tool ran is wrapped; a read's failure and a write the server certainly rejected
            # are re-raised as they are.
            if write and not _failed_before_execution(error):
                raise McpOutcomeUnknownError(name) from error
            raise

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        tool = self._tools.get(op)
        if tool is None:
            raise ValueError(f'unknown operation "{op}"')
        if op in self.query_ops:
            result = await self._call(
                op,
                dict(coerce_tool_arguments(args, tool.input_schema, max_limit=self._max_limit)),
                write=False,
            )
            return to_tabular_data(
                result,
                self.data_version(),
                op,
                max_rows=self._max_rows,
                max_result_bytes=self._max_result_bytes,
            )
        result = await self._call(op, dict(args), write=True)
        assert_tool_succeeded(result, op)
        return _action_result(payload_of(result))

    def describe_shape(self, ref: QueryRef) -> DataShape | None:
        """The column shape of a query op, from its tool's `outputSchema`; None when it has none or is not a
        query."""
        if ref.path not in self.query_ops:
            return None
        tool = self._tools.get(ref.path)
        return shape_from_output_schema(tool.output_schema) if tool is not None else None


async def create_mcp_domain_port(
    *,
    client: McpToolClientLike,
    include: Callable[[McpToolInfo], bool] | None = None,
    is_read_only: Callable[[McpToolInfo], bool] | None = None,
    tier_for: Callable[[McpToolInfo], ActionTier | None] | None = None,
    data_version: Callable[[], str] | None = None,
    call_timeout_ms: int | float = DEFAULT_CALL_TIMEOUT_MS,
    max_limit: int | float = DEFAULT_MAX_LIMIT,
    max_rows: int = DEFAULT_MAX_ROWS,
    max_result_bytes: int = DEFAULT_MAX_RESULT_BYTES,
    on_schema_projection: Callable[[SchemaProjectionReport], None] | None = None,
    on_skip: Callable[[SkipReport], None] | None = None,
) -> McpDomainPort:
    """Build a kohaku `DomainPort` over an existing MCP server. The tool list is read once, here (a later
    `tools/list_changed` is not followed: restart the host to pick up a new tool).

    - A tool with `annotations.read_only_hint is True` (or whatever `is_read_only` says) is a query: a
      `query://` ref whose path is the tool name resolves by calling it, and the result becomes `TabularData`.
      It carries no `tier`. **`readOnlyHint` is a hint from the server, not a guarantee**: a server that marks a
      write tool read-only bypasses the approve gate. Use this adapter only with MCP servers you trust, or
      classify the tools yourself with `is_read_only` (and `include`).
    - Every other tool is an Action with `tier="approve"` (override with `tier_for`; a None return keeps
      "approve"). Its `paramsSchema` is the projection of its `inputSchema` onto kohaku's closed subset, or absent
      when that is impossible; the approver then judges the raw payload, and the description says so.
    - The calling principal is not forwarded to the MCP server: authenticating to it is the client transport's
      job, so every caller shares one upstream credential.
    - A duplicated tool name is skipped (the first wins) unless the copies disagree on read-only vs write, in
      which case every copy is dropped (fail closed).

    `include` selects which tools to expose at all (default: every listed tool) and is applied before the name and
    duplicate checks. `data_version` is stamped on every `TabularData` this port returns (default
    `mcp_data_version()`); pass the same function to the host's data version (or read it back from
    `port.data_version`). Even then a Spec composed just before a bucket boundary is stale once after it, and a
    successful write does not change the version until the next bucket. `call_timeout_ms` (default 30000) is the
    deadline of one upstream call: the request is cancelled, never retried. `max_limit` caps the tool's numeric
    `limit` argument; `max_rows` / `max_result_bytes` bound one query result. `on_schema_projection` is called
    once per exposed tool whose projection lost something or was impossible; `on_skip` for a listed tool left
    out because its name is unusable or duplicated.
    """
    if call_timeout_ms <= 0:
        raise ValueError(
            f"create_mcp_domain_port: call_timeout_ms must be positive, got {call_timeout_ms}"
        )
    version = data_version if data_version is not None else mcp_data_version()
    read_only = is_read_only if is_read_only is not None else _default_is_read_only

    listed = await _list_all_tools(client)
    # `include` and the name check come first, so a tool the caller left out never counts as a duplicate.
    candidates = [
        tool
        for tool in listed
        if _TOOL_NAME_PATTERN.fullmatch(tool.name) is not None
        and (include is None or include(tool))
    ]
    classes: dict[str, set[bool]] = {}
    for tool in candidates:
        classes.setdefault(tool.name, set()).add(read_only(tool))

    tools: dict[str, McpToolInfo] = {}
    operations: list[OperationDescriptor] = []
    query_names: list[str] = []
    action_names: list[str] = []

    for tool in listed:
        if _TOOL_NAME_PATTERN.fullmatch(tool.name) is None:
            if on_skip is not None:
                on_skip(
                    SkipReport(
                        tool=tool.name,
                        reason="the tool name is not usable as a query:// path segment",
                    )
                )
            continue
        if include is not None and not include(tool):
            continue
        if len(classes.get(tool.name, set())) > 1:
            if on_skip is not None:
                on_skip(
                    SkipReport(
                        tool=tool.name,
                        reason="several tools share this name and disagree on whether it is read-only; "
                        "all were dropped",
                    )
                )
            continue
        if tool.name in tools:
            if on_skip is not None:
                on_skip(
                    SkipReport(tool=tool.name, reason="a tool with this name was already listed")
                )
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
        if read_only(tool):
            query_names.append(tool.name)
            operations.append(_describe_operation(tool, projection, None))
        else:
            action_names.append(tool.name)
            tier = tier_for(tool) if tier_for is not None else None
            operations.append(_describe_operation(tool, projection, tier or "approve"))

    return McpDomainPort(
        client=client,
        tools=tools,
        operations=operations,
        query_names=frozenset(query_names),
        action_names=frozenset(action_names),
        data_version=version,
        call_timeout_ms=call_timeout_ms,
        max_limit=max_limit,
        max_rows=max_rows,
        max_result_bytes=max_result_bytes,
    )

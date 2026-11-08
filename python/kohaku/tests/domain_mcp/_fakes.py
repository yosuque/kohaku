"""A scripted MCP client for kohaku.domain_mcp tests (port of packages/domain-mcp/test/fake-client.ts)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class FakeAnnotations:
    read_only_hint: bool | None = None


@dataclass(frozen=True)
class FakeTool:
    name: str
    input_schema: dict[str, Any]
    title: str | None = None
    description: str | None = None
    output_schema: dict[str, Any] | None = None
    annotations: FakeAnnotations | None = None


@dataclass(frozen=True)
class FakeContent:
    type: str
    text: str | None = None


@dataclass(frozen=True)
class FakeResult:
    content: list[Any] = field(default_factory=list)
    structured_content: Any = None
    is_error: bool = False


@dataclass(frozen=True)
class FakeListResult:
    tools: list[FakeTool]
    next_cursor: str | None = None


class FakeClient:
    """Fixed tool list (optionally paged) and per-tool results."""

    def __init__(
        self,
        tools: list[FakeTool],
        results: dict[str, FakeResult] | None = None,
        page_size: int | None = None,
    ) -> None:
        self._tools = tools
        self._results = results or {}
        self._page_size = page_size if page_size is not None else max(len(tools), 1)
        self.calls: list[tuple[str, dict[str, Any] | None]] = []
        self.list_calls: list[str | None] = []

    async def list_tools(self, *, cursor: str | None = None) -> FakeListResult:
        self.list_calls.append(cursor)
        start = 0 if cursor is None else int(cursor)
        end = start + self._page_size
        page = self._tools[start:end]
        return FakeListResult(tools=page, next_cursor=str(end) if end < len(self._tools) else None)

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> FakeResult:
        self.calls.append((name, arguments))
        result = self._results.get(name)
        if result is None:
            raise RuntimeError(f"no scripted result for {name}")
        return result


LIST_ORDERS = FakeTool(
    name="list_orders",
    description="List orders",
    input_schema={
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["open", "paid"], "description": "Order status"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
    },
    output_schema={
        "type": "object",
        "properties": {
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "total": {"type": "number"},
                        "placedAt": {"type": "string", "format": "date"},
                    },
                },
            }
        },
    },
    annotations=FakeAnnotations(read_only_hint=True),
)

REFUND_ORDER = FakeTool(
    name="refund_order",
    description="Refund an order",
    input_schema={
        "type": "object",
        "properties": {
            "orderId": {"type": "string", "description": "Order id"},
            "amount": {"type": "number", "minimum": 0},
        },
        "required": ["orderId"],
    },
    annotations=FakeAnnotations(read_only_hint=False),
)

UNANNOTATED = FakeTool(name="touch_thing", input_schema={"type": "object", "properties": {}})

ORDER_ROWS: list[dict[str, Any]] = [
    {"id": "o-1", "total": 10, "placedAt": "2026-04-01"},
    {"id": "o-2", "total": 20, "placedAt": "2026-04-02"},
]

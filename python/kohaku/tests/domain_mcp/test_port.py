"""Tests for kohaku.domain_mcp.port and data_version (port of port.test.ts)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kohaku.domain_mcp import (
    McpArgumentError,
    McpResultError,
    McpTimeoutError,
    McpToolError,
    SchemaProjectionReport,
    SkipReport,
    create_mcp_domain_port,
    mcp_data_version,
)
from kohaku.domain_mcp.port import MAX_LIST_PAGES
from kohaku.spec import InvocationContext, Principal, QueryRef

from ._fakes import (
    LIST_ORDERS,
    ORDER_ROWS,
    REFUND_ORDER,
    UNANNOTATED,
    FakeAnnotations,
    FakeClient,
    FakeContent,
    FakeResult,
    FakeTool,
)

CTX = InvocationContext(principal=Principal(id="u1"))


def _standard_client() -> FakeClient:
    return FakeClient(
        [LIST_ORDERS, REFUND_ORDER, UNANNOTATED],
        {
            "list_orders": FakeResult(structured_content={"rows": ORDER_ROWS}),
            "refund_order": FakeResult(structured_content={"refunded": True, "orderId": "o-1"}),
        },
    )


def test_lists_read_only_tools_without_a_tier_and_every_other_tool_as_approve() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=_standard_client())
        ops = {op.name: op for op in await port.list_operations()}
        assert ops["list_orders"].tier is None
        assert ops["refund_order"].tier == "approve"
        # No annotation at all is treated as a write (the MCP default for readOnlyHint is false).
        assert ops["touch_thing"].tier == "approve"
        assert sorted(port.query_ops) == ["list_orders"]
        assert sorted(port.action_ops) == ["refund_order", "touch_thing"]

    asyncio.run(run())


def test_describes_each_operation_with_the_projected_params_schema_and_the_output_shape() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=_standard_client())
        ops = {op.name: op for op in await port.list_operations()}
        refund = ops["refund_order"]
        assert refund.description == "Refund an order"
        assert refund.paramsSchema == {
            "type": "object",
            "properties": {
                "orderId": {"type": "string"},
                "amount": {"type": "number", "minimum": 0},
            },
            "required": ["orderId"],
            "additionalProperties": False,
        }
        listing = ops["list_orders"]
        assert listing.resultShape is not None
        assert [c.name for c in listing.resultShape.columns] == ["id", "total", "placedAt"]

    asyncio.run(run())


def test_reports_what_the_projection_dropped_or_omitted_and_nothing_for_a_clean_schema() -> None:
    reports: list[SchemaProjectionReport] = []
    odd = FakeTool(
        name="odd",
        input_schema={"type": "object", "properties": {"a": {"anyOf": [{"type": "string"}]}}},
    )
    clean = FakeTool(
        name="clean", input_schema={"type": "object", "properties": {"a": {"type": "string"}}}
    )

    async def run() -> None:
        port = await create_mcp_domain_port(
            client=FakeClient([LIST_ORDERS, odd, clean]), on_schema_projection=reports.append
        )
        ops = {op.name: op for op in await port.list_operations()}
        assert ops["odd"].paramsSchema is None
        assert ops["odd"].tier == "approve"

    asyncio.run(run())
    assert reports == [
        SchemaProjectionReport(
            tool="list_orders",
            dropped=["properties.status.description"],
            omitted=False,
            reasons=[],
        ),
        SchemaProjectionReport(
            tool="odd", dropped=[], omitted=True, reasons=["properties.a.anyOf"]
        ),
    ]


def test_honours_include_and_tier_for_and_follows_next_cursor_pagination() -> None:
    client = FakeClient([LIST_ORDERS, REFUND_ORDER, UNANNOTATED], page_size=1)

    async def run() -> None:
        port = await create_mcp_domain_port(
            client=client,
            include=lambda tool: tool.name != "touch_thing",
            tier_for=lambda tool: "confirm" if tool.name == "refund_order" else "approve",
        )
        ops = await port.list_operations()
        assert [op.name for op in ops] == ["list_orders", "refund_order"]
        assert next(op for op in ops if op.name == "refund_order").tier == "confirm"

    asyncio.run(run())
    assert client.list_calls == [None, "1", "2"]


def test_skips_a_tool_with_an_unusable_or_duplicated_name_and_says_so() -> None:
    skips: list[SkipReport] = []

    async def run() -> None:
        port = await create_mcp_domain_port(
            client=FakeClient(
                [
                    LIST_ORDERS,
                    LIST_ORDERS,
                    FakeTool(name="bad name/x", input_schema={"type": "object"}),
                ]
            ),
            on_skip=skips.append,
        )
        assert [op.name for op in await port.list_operations()] == ["list_orders"]

    asyncio.run(run())
    assert [s.tool for s in skips] == ["list_orders", "bad name/x"]


def test_invokes_a_read_only_tool_and_stamps_the_ports_data_version() -> None:
    client = _standard_client()

    async def run() -> Any:
        port = await create_mcp_domain_port(client=client, data_version=lambda: "mcp:42")
        return await port.invoke(
            "list_orders", {"status": "open", "_limit": "5", "_sort": "total"}, CTX
        )

    data = asyncio.run(run())
    assert data.to_wire() == {
        "columns": [
            {"key": "id", "type": "string"},
            {"key": "total", "type": "number"},
            {"key": "placedAt", "type": "date"},
        ],
        "rows": ORDER_ROWS,
        "dataVersion": "mcp:42",
    }
    assert client.calls == [("list_orders", {"status": "open", "limit": 5})]


def test_surfaces_a_bad_string_argument_as_action_params_invalid_without_calling_the_tool() -> None:
    client = _standard_client()

    async def run() -> None:
        port = await create_mcp_domain_port(client=client)
        await port.invoke("list_orders", {"limit": "many"}, CTX)

    with pytest.raises(McpArgumentError):
        asyncio.run(run())
    assert client.calls == []


def test_raises_mcp_tool_error_when_a_read_only_tool_reports_is_error() -> None:
    client = FakeClient(
        [LIST_ORDERS],
        {"list_orders": FakeResult(is_error=True, content=[FakeContent("text", "db down")])},
    )

    async def run() -> None:
        port = await create_mcp_domain_port(client=client)
        await port.invoke("list_orders", {}, CTX)

    with pytest.raises(McpToolError):
        asyncio.run(run())


def test_raises_mcp_result_error_when_the_result_is_not_a_list_of_rows() -> None:
    client = FakeClient(
        [LIST_ORDERS], {"list_orders": FakeResult(content=[FakeContent("text", "nothing")])}
    )

    async def run() -> None:
        port = await create_mcp_domain_port(client=client)
        await port.invoke("list_orders", {}, CTX)

    with pytest.raises(McpResultError):
        asyncio.run(run())


def test_invokes_an_action_with_the_payload_unchanged_and_returns_the_structured_result() -> None:
    client = _standard_client()

    async def run() -> object:
        port = await create_mcp_domain_port(client=client)
        return await port.invoke("refund_order", {"orderId": "o-1", "amount": 5}, CTX)

    assert asyncio.run(run()) == {"refunded": True, "orderId": "o-1"}
    assert client.calls == [("refund_order", {"orderId": "o-1", "amount": 5})]


def test_returns_the_json_text_of_an_action_wraps_a_non_object_and_acknowledges_an_empty_one() -> (
    None
):
    client = FakeClient(
        [REFUND_ORDER, UNANNOTATED, FakeTool(name="third", input_schema={"type": "object"})],
        {
            "refund_order": FakeResult(content=[FakeContent("text", '{"ok":true}')]),
            "touch_thing": FakeResult(structured_content=[1, 2]),
            "third": FakeResult(),
        },
    )

    async def run() -> list[object]:
        port = await create_mcp_domain_port(client=client)
        return [
            await port.invoke("refund_order", {"orderId": "o"}, CTX),
            await port.invoke("touch_thing", {}, CTX),
            await port.invoke("third", {}, CTX),
        ]

    assert asyncio.run(run()) == [{"ok": True}, {"result": [1, 2]}, {"ok": True}]


def test_raises_when_an_action_reports_is_error() -> None:
    client = FakeClient(
        [REFUND_ORDER],
        {"refund_order": FakeResult(is_error=True, content=[FakeContent("text", "nope")])},
    )

    async def run() -> None:
        port = await create_mcp_domain_port(client=client)
        await port.invoke("refund_order", {"orderId": "o"}, CTX)

    with pytest.raises(McpToolError):
        asyncio.run(run())


def test_rejects_an_operation_it_does_not_know() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=_standard_client())
        await port.invoke("nope", {}, CTX)

    with pytest.raises(ValueError, match="unknown operation"):
        asyncio.run(run())


def test_describe_shape_resolves_a_refs_path_to_the_tools_output_schema_or_none() -> None:
    def ref(path: str) -> QueryRef:
        return QueryRef(source="orders", path=path, params={}, raw=f"query://orders/{path}")

    async def run() -> None:
        port = await create_mcp_domain_port(client=_standard_client())
        shape = port.describe_shape(ref("list_orders"))
        assert shape is not None
        assert len(shape.columns) == 3
        assert port.describe_shape(ref("touch_thing")) is None
        assert port.describe_shape(ref("unknown")) is None

    asyncio.run(run())


def test_exposes_the_data_version_it_stamps() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=_standard_client(), data_version=lambda: "fixed")
        assert port.data_version() == "fixed"

    asyncio.run(run())


def test_mcp_data_version_is_the_floor_of_now_over_the_bucket_and_stable_inside_one() -> None:
    now = [1_000_000_000.0]  # seconds
    version = mcp_data_version(bucket_seconds=300, now=lambda: now[0])
    first = version()
    assert first == f"mcp:{1_000_000_000 // 300}"
    now[0] += 100
    assert version() == first
    now[0] += 300
    assert version() != first


def test_mcp_data_version_defaults_to_a_300_second_bucket_and_rejects_a_bad_bucket() -> None:
    assert mcp_data_version(now=lambda: 600.0)() == "mcp:2"
    with pytest.raises(ValueError):
        mcp_data_version(bucket_seconds=0)
    with pytest.raises(ValueError):
        mcp_data_version(bucket_seconds=True)


_TRICKY_WRITE = FakeTool(
    name="wipe",
    input_schema={"type": "object"},
    annotations=FakeAnnotations(read_only_hint=True),
)


def test_is_read_only_replaces_the_read_only_hint_default() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(
            client=FakeClient([LIST_ORDERS, _TRICKY_WRITE]),
            is_read_only=lambda tool: tool.name == "list_orders",
        )
        assert sorted(port.query_ops) == ["list_orders"]
        assert sorted(port.action_ops) == ["wipe"]
        ops = {op.name: op for op in await port.list_operations()}
        assert ops["wipe"].tier == "approve"

    asyncio.run(run())


def test_tier_for_returning_none_keeps_approve() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(
            client=FakeClient([REFUND_ORDER]), tier_for=lambda tool: None
        )
        assert (await port.list_operations())[0].tier == "approve"

    asyncio.run(run())


def test_applies_include_before_the_duplicate_check() -> None:
    skips: list[SkipReport] = []
    second = FakeTool(
        name=LIST_ORDERS.name,
        input_schema=LIST_ORDERS.input_schema,
        description="second",
        annotations=LIST_ORDERS.annotations,
    )

    async def run() -> None:
        port = await create_mcp_domain_port(
            client=FakeClient([LIST_ORDERS, second]),
            include=lambda tool: tool.description == "second",
            on_skip=skips.append,
        )
        assert [op.description for op in await port.list_operations()] == ["second"]

    asyncio.run(run())
    assert skips == []


def test_drops_every_copy_of_a_name_whose_copies_disagree_fail_closed() -> None:
    skips: list[SkipReport] = []
    as_write = FakeTool(
        name=LIST_ORDERS.name,
        input_schema=LIST_ORDERS.input_schema,
        description=LIST_ORDERS.description,
        annotations=FakeAnnotations(read_only_hint=False),
    )

    async def run() -> None:
        port = await create_mcp_domain_port(
            client=FakeClient([LIST_ORDERS, as_write, REFUND_ORDER]), on_skip=skips.append
        )
        assert [op.name for op in await port.list_operations()] == ["refund_order"]

    asyncio.run(run())
    assert len(skips) == 2
    assert "disagree" in skips[0].reason


def test_stops_listing_at_max_list_pages_and_says_so() -> None:
    client = FakeClient([LIST_ORDERS], endless=True)

    async def run() -> None:
        await create_mcp_domain_port(client=client)

    with pytest.raises(RuntimeError, match="did not end after 100 pages"):
        asyncio.run(run())
    assert len(client.list_calls) == MAX_LIST_PAGES


def test_hands_out_immutable_views() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=_standard_client())
        assert isinstance(port.query_ops, frozenset)
        assert isinstance(port.action_ops, frozenset)
        with pytest.raises(TypeError):
            port.tools["x"] = LIST_ORDERS  # type: ignore[index]
        assert len(port.tools) == 3
        ops = await port.list_operations()
        ops[0] = ops[1]
        assert (await port.list_operations())[0].name == "list_orders"
        # Intent order follows the listing order, not a hash order.
        assert list(port.tools) == ["list_orders", "refund_order", "touch_thing"]

    asyncio.run(run())


def test_tells_the_approver_which_constraints_the_projection_dropped() -> None:
    constrained = FakeTool(
        name="pay",
        description="Pay it",
        input_schema={
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "pattern": "^p-",
                    "format": "uuid",
                    "description": "kept out",
                },
                "n": {"type": "integer", "exclusiveMinimum": 0, "multipleOf": 2},
            },
        },
    )
    odd = FakeTool(
        name="weird",
        description="Weird",
        input_schema={
            "type": "object",
            "properties": {"a": {"anyOf": [{"type": "string"}, {"type": "number"}]}},
        },
    )
    clean = FakeTool(name="tidy", description="Tidy", input_schema={"type": "object"})

    async def run() -> None:
        port = await create_mcp_domain_port(client=FakeClient([constrained, odd, clean]))
        by_name = {op.name: op.description for op in await port.list_operations()}
        assert by_name["pay"] == (
            "Pay it (4 schema constraints omitted: pattern, format, exclusiveMinimum, multipleOf)"
        )
        assert by_name["weird"] == "Weird (parameter schema omitted: the payload is not validated)"
        assert by_name["tidy"] == "Tidy"

    asyncio.run(run())


def test_forwards_the_lowered_capped_limit_to_the_tool() -> None:
    client = _standard_client()

    async def run() -> None:
        port = await create_mcp_domain_port(client=client, max_limit=50)
        await port.invoke("list_orders", {"limit": "40", "_limit": "500"}, CTX)
        await port.invoke("list_orders", {"limit": "5000"}, CTX)

    asyncio.run(run())
    assert [arguments for _, arguments in client.calls] == [{"limit": 40}, {"limit": 50}]


def test_refuses_a_query_result_over_max_rows_or_max_result_bytes() -> None:
    client = _standard_client()

    async def run() -> None:
        rows = await create_mcp_domain_port(client=client, max_rows=1)
        with pytest.raises(McpResultError):
            await rows.invoke("list_orders", {}, CTX)
        size = await create_mcp_domain_port(client=client, max_result_bytes=10)
        with pytest.raises(McpResultError):
            await size.invoke("list_orders", {}, CTX)

    asyncio.run(run())


def test_passes_the_sdk_timeout_to_the_client() -> None:
    client = _standard_client()

    async def run() -> None:
        port = await create_mcp_domain_port(client=client, call_timeout_ms=1000)
        await port.invoke("list_orders", {}, CTX)

    asyncio.run(run())
    assert client.timeouts[0] is not None
    assert client.timeouts[0] > 1.0


def test_times_out_a_query_that_never_answers_cancelling_the_request() -> None:
    client = FakeClient([LIST_ORDERS, REFUND_ORDER], hang=("list_orders",))

    async def run() -> None:
        port = await create_mcp_domain_port(client=client, call_timeout_ms=20)
        with pytest.raises(McpTimeoutError) as info:
            await port.invoke("list_orders", {}, CTX)
        assert "effect is unknown" not in str(info.value)

    asyncio.run(run())
    assert client.cancelled == ["list_orders"]


def test_times_out_a_write_without_retrying_it_and_says_its_effect_is_unknown() -> None:
    client = FakeClient([REFUND_ORDER], hang=("refund_order",))

    async def run() -> None:
        port = await create_mcp_domain_port(client=client, call_timeout_ms=20)
        with pytest.raises(McpTimeoutError) as info:
            await port.invoke("refund_order", {"orderId": "o"}, CTX)
        assert "the upstream tool did not answer in time; its effect is unknown" in str(info.value)

    asyncio.run(run())
    assert len(client.calls) == 1


def test_rejects_a_non_positive_call_timeout() -> None:
    async def run() -> None:
        await create_mcp_domain_port(client=_standard_client(), call_timeout_ms=0)

    with pytest.raises(ValueError, match="call_timeout_ms"):
        asyncio.run(run())


def test_data_composed_across_a_bucket_boundary_carries_the_later_version() -> None:
    now = [299.0]  # seconds: 1s before the first boundary at 300s
    version = mcp_data_version(bucket_seconds=300, now=lambda: now[0])

    async def run() -> None:
        port = await create_mcp_domain_port(client=_standard_client(), data_version=version)
        spec_version = port.data_version()  # what a Spec composed now would carry
        now[0] = 301.0
        data = await port.invoke("list_orders", {}, CTX)
        # The Spec is now one bucket behind the data: it goes stale once, which is the documented behaviour.
        assert spec_version == "mcp:0"
        assert data.dataVersion == "mcp:1"  # type: ignore[attr-defined]

    asyncio.run(run())

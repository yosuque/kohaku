"""Tests for kohaku.domain_mcp.intents (port of intents.test.ts)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kohaku.domain_mcp import SkipReport, create_mcp_domain_port, create_mcp_intents
from kohaku.intents import ParamError
from kohaku.spec import QueryHandle

from ._fakes import LIST_ORDERS, REFUND_ORDER, FakeAnnotations, FakeClient, FakeTool


def _read_tool(name: str, input_schema: dict[str, Any]) -> FakeTool:
    return FakeTool(
        name=name,
        input_schema=input_schema,
        annotations=FakeAnnotations(read_only_hint=True),
    )


def test_makes_one_intent_per_read_only_tool_and_none_for_an_action() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=FakeClient([LIST_ORDERS, REFUND_ORDER]))
        intents = create_mcp_intents(port, source="orders")
        assert [i.name for i in intents] == ["orders.list_orders"]
        assert intents[0].description == "List orders"

    asyncio.run(run())


def test_derives_the_params_from_the_input_schema_and_resolves_them_to_a_query_ref() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=FakeClient([LIST_ORDERS]))
        (intent,) = create_mcp_intents(port, source="orders")
        # Every parameter is optional here, and a string is coerced to the declared number type.
        assert intent.params.parse({"status": "open", "limit": "5"}) == {
            "status": "open",
            "limit": 5,
        }
        assert intent.params.parse({}) == {}
        with pytest.raises(ParamError):
            intent.params.parse({"status": "bogus"})
        with pytest.raises(ParamError):
            intent.params.parse({"limit": 0})
        assert intent.to_queries({"status": "open", "limit": 5}) == [
            QueryHandle(uri="query://orders/list_orders?limit=5&status=open")
        ]
        assert intent.to_queries({}) == [QueryHandle(uri="query://orders/list_orders")]

    asyncio.run(run())


def test_requires_the_input_schemas_required_parameters() -> None:
    tool = _read_tool(
        "search",
        {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
    )

    async def run() -> None:
        port = await create_mcp_domain_port(client=FakeClient([tool]))
        (intent,) = create_mcp_intents(port, source="docs")
        with pytest.raises(ParamError):
            intent.params.parse({})
        assert intent.params.parse({"q": "x"}) == {"q": "x"}

    asyncio.run(run())


def test_leaves_out_an_optional_unsupported_parameter_and_skips_a_tool_that_requires_one() -> None:
    skips: list[SkipReport] = []
    with_optional = _read_tool(
        "a",
        {"type": "object", "properties": {"n": {"type": "number"}, "flag": {"type": "boolean"}}},
    )
    with_required = _read_tool(
        "b",
        {"type": "object", "properties": {"ids": {"type": "array"}}, "required": ["ids"]},
    )

    async def run() -> None:
        port = await create_mcp_domain_port(client=FakeClient([with_optional, with_required]))
        intents = create_mcp_intents(port, source="x", on_skip=skips.append)
        assert [i.name for i in intents] == ["x.a"]
        assert list(intents[0].params.shape) == ["n"]

    asyncio.run(run())
    assert len(skips) == 1
    assert skips[0].tool == "b"
    assert "ids" in skips[0].reason


def test_reads_a_parameter_through_a_nullable_any_of() -> None:
    tool = _read_tool(
        "find",
        {
            "type": "object",
            "properties": {
                "limit": {"anyOf": [{"type": "integer"}, {"type": "null"}], "default": None},
                "kind": {"anyOf": [{"type": "string", "enum": ["a", "b"]}, {"type": "null"}]},
                "odd": {"anyOf": [{"type": "integer"}, {"type": "string"}]},
            },
        },
    )

    async def run() -> None:
        port = await create_mcp_domain_port(client=FakeClient([tool]))
        (intent,) = create_mcp_intents(port, source="x")
        # `odd` is a genuine union, not an optional: it stays out of the Intent.
        assert list(intent.params.shape) == ["limit", "kind"]
        assert intent.params.parse({"limit": "3", "kind": "a"}) == {"limit": 3, "kind": "a"}
        with pytest.raises(ParamError):
            intent.params.parse({"kind": "zzz"})

    asyncio.run(run())


def test_derives_a_canonical_name_and_refuses_two_tools_that_map_to_the_same_one() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(
            client=FakeClient(
                [
                    _read_tool("Get-Orders", {"type": "object"}),
                    _read_tool("9lives", {"type": "object"}),
                ]
            )
        )
        assert [i.name for i in create_mcp_intents(port, source="orders")] == [
            "orders.get_orders",
            "orders.t_9lives",
        ]
        clash = await create_mcp_domain_port(
            client=FakeClient(
                [_read_tool("a-b", {"type": "object"}), _read_tool("a_b", {"type": "object"})]
            )
        )
        with pytest.raises(ValueError, match="same canonical"):
            create_mcp_intents(clash, source="orders")

    asyncio.run(run())


def test_rejects_a_source_that_cannot_prefix_a_canonical_name() -> None:
    async def run() -> None:
        port = await create_mcp_domain_port(client=FakeClient([]))
        with pytest.raises(ValueError, match="source"):
            create_mcp_intents(port, source="Bad Source")

    asyncio.run(run())

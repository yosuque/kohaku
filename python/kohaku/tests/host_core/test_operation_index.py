"""Tests for create_operation_index (port of packages/host-core/test/operation-index.test.ts)."""

from __future__ import annotations

import asyncio

import pytest

from kohaku.host_core.operation_index import create_operation_index
from kohaku.spec import (
    ActionParamsSchemaError,
    DomainPort,
    InvocationContext,
    JsonObject,
    OperationDescriptor,
)

NOTE_SCHEMA = {
    "type": "object",
    "properties": {"note": {"type": "string", "maxLength": 500}},
    "required": ["note"],
    "additionalProperties": False,
}


class _FakeDomain:
    def __init__(self, script: list[list[OperationDescriptor] | BaseException]) -> None:
        self._script = list(script)
        self.calls = 0

    async def list_operations(self) -> list[OperationDescriptor]:
        self.calls += 1
        outcome = self._script[min(self.calls, len(self._script)) - 1]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        return None


def test_memoizes_list_operations_across_calls_keyed_by_operation_name() -> None:
    domain_impl = _FakeDomain(
        [
            [
                OperationDescriptor(
                    name="annotate", description="d", paramsSchema=NOTE_SCHEMA, tier="confirm"
                ),
                OperationDescriptor(name="publish", description="d"),
            ]
        ]
    )
    domain: DomainPort = domain_impl

    async def run() -> None:
        index = create_operation_index(domain)
        a = await index()
        b = await index()
        assert domain_impl.calls == 1
        assert a is b
        assert sorted(a.keys()) == ["annotate", "publish"]
        assert a["annotate"].descriptor.tier == "confirm"
        assert a["annotate"].params_schema == NOTE_SCHEMA
        assert a["publish"].params_schema is None

    asyncio.run(run())


def test_raises_action_params_schema_error_for_a_disallowed_keyword() -> None:
    domain_impl = _FakeDomain(
        [[OperationDescriptor(name="annotate", description="d", paramsSchema={"type": "string", "pattern": "^a+$"})]]
    )
    domain: DomainPort = domain_impl

    async def run() -> None:
        index = create_operation_index(domain)
        with pytest.raises(ActionParamsSchemaError):
            await index()

    asyncio.run(run())


def test_propagates_a_list_operations_rejection_and_notifies_on_error() -> None:
    boom = RuntimeError("domain unavailable")
    domain: DomainPort = _FakeDomain([boom])
    seen: list[BaseException] = []

    async def run() -> None:
        index = create_operation_index(domain, seen.append)
        with pytest.raises(RuntimeError):
            await index()
        assert seen == [boom]

    asyncio.run(run())


def test_discards_the_cached_rejection_so_the_next_call_retries() -> None:
    boom = RuntimeError("transient")
    domain_impl = _FakeDomain([boom, [OperationDescriptor(name="annotate", description="d")]])
    domain: DomainPort = domain_impl

    async def run() -> None:
        index = create_operation_index(domain)
        with pytest.raises(RuntimeError):
            await index()
        assert domain_impl.calls == 1
        retried = await index()
        assert domain_impl.calls == 2
        assert sorted(retried.keys()) == ["annotate"]

    asyncio.run(run())

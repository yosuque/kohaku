"""Tests for create_operation_index (port of packages/host-core/test/operation-index.test.ts)."""

from __future__ import annotations

import asyncio

import pytest

from kohaku.host_core.allowed_actions import allowed_actions_from_index
from kohaku.host_core.operation_index import (
    create_operation_index,
    start_operation_index_validation,
)
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


def test_allowed_actions_from_index_shares_one_list_operations_read() -> None:
    domain_impl = _FakeDomain(
        [[OperationDescriptor(name="annotate", description="d"), OperationDescriptor(name="publish", description="d")]]
    )
    domain: DomainPort = domain_impl
    index = create_operation_index(domain)
    allowed = allowed_actions_from_index(index)

    async def run() -> None:
        assert await allowed() == frozenset({"annotate", "publish"})
        await index()
        await allowed()

    asyncio.run(run())
    assert domain_impl.calls == 1


def test_allowed_actions_from_index_propagates_a_schema_error_and_recovers_after_a_retry() -> None:
    bad = OperationDescriptor(name="annotate", description="d", paramsSchema={"type": "string", "pattern": "x"})
    good = OperationDescriptor(name="annotate", description="d")
    domain_impl = _FakeDomain([[bad], [good]])
    domain: DomainPort = domain_impl
    allowed = allowed_actions_from_index(create_operation_index(domain))

    async def run() -> None:
        with pytest.raises(ActionParamsSchemaError):
            await allowed()
        assert await allowed() == frozenset({"annotate"})

    asyncio.run(run())


def test_start_operation_index_validation_reports_a_failure_in_the_background() -> None:
    bad = OperationDescriptor(name="annotate", description="d", paramsSchema={"type": "string", "pattern": "x"})
    domain: DomainPort = _FakeDomain([[bad]])
    reported: list[BaseException] = []

    async def report(exc: BaseException) -> None:
        reported.append(exc)

    async def run() -> None:
        task = start_operation_index_validation(create_operation_index(domain), report)
        assert task is not None
        await task

    asyncio.run(run())
    assert len(reported) == 1
    assert isinstance(reported[0], ActionParamsSchemaError)


def test_start_operation_index_validation_reports_nothing_for_a_valid_domain() -> None:
    domain: DomainPort = _FakeDomain([[OperationDescriptor(name="annotate", description="d")]])
    reported: list[BaseException] = []

    async def report(exc: BaseException) -> None:
        reported.append(exc)

    async def run() -> None:
        task = start_operation_index_validation(create_operation_index(domain), report)
        assert task is not None
        await task

    asyncio.run(run())
    assert reported == []


def test_start_operation_index_validation_is_a_no_op_without_a_running_event_loop() -> None:
    domain_impl = _FakeDomain([[OperationDescriptor(name="annotate", description="d")]])
    domain: DomainPort = domain_impl

    async def report(exc: BaseException) -> None:
        raise AssertionError("must not be called")

    assert start_operation_index_validation(create_operation_index(domain), report) is None
    assert domain_impl.calls == 0

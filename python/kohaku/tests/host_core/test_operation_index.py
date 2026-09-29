"""Tests for create_operation_index (port of packages/host-core/test/operation-index.test.ts)."""

from __future__ import annotations

import asyncio

import pytest

from kohaku.host_core.allowed_actions import allowed_actions_from_index
from kohaku.host_core.operation_index import (
    create_operation_index,
    start_operation_index_validation,
    validate_operation_index,
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


def test_a_bad_params_schema_is_confined_to_its_own_operation() -> None:
    bad = {"type": "string", "pattern": "^a+$"}
    domain: DomainPort = _FakeDomain(
        [
            [
                OperationDescriptor(name="annotate", description="d", paramsSchema=bad),
                OperationDescriptor(name="publish", description="d", paramsSchema=NOTE_SCHEMA),
            ]
        ]
    )

    async def run() -> None:
        index = await create_operation_index(domain)()
        assert list(index) == ["annotate", "publish"]
        assert isinstance(index["annotate"].schema_error, ActionParamsSchemaError)
        assert index["annotate"].params_schema is None
        assert index["publish"].schema_error is None
        assert index["publish"].params_schema == NOTE_SCHEMA

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


def test_allowed_actions_from_index_keeps_an_operation_with_a_bad_schema_and_propagates_a_rejection() -> None:
    bad = OperationDescriptor(name="annotate", description="d", paramsSchema={"type": "string", "pattern": "x"})
    publish = OperationDescriptor(name="publish", description="d")
    domain: DomainPort = _FakeDomain([RuntimeError("down"), [bad, publish]])
    allowed = allowed_actions_from_index(create_operation_index(domain))

    async def run() -> None:
        with pytest.raises(RuntimeError):
            await allowed()
        assert await allowed() == frozenset({"annotate", "publish"})

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


def test_validate_operation_index_reports_each_schema_error_and_a_build_failure() -> None:
    bad = {"type": "string", "pattern": "x"}
    reported: list[BaseException] = []

    async def report(exc: BaseException) -> None:
        reported.append(exc)

    ops = [
        OperationDescriptor(name="a", description="d", paramsSchema=bad),
        OperationDescriptor(name="b", description="d", paramsSchema=bad),
        OperationDescriptor(name="c", description="d"),
    ]
    domain: DomainPort = _FakeDomain([ops])
    failing: DomainPort = _FakeDomain([RuntimeError("down")])

    async def run() -> None:
        await validate_operation_index(create_operation_index(domain), report)
        assert len(reported) == 2
        assert all(isinstance(e, ActionParamsSchemaError) for e in reported)
        await validate_operation_index(create_operation_index(failing), report)
        assert len(reported) == 3

    asyncio.run(run())

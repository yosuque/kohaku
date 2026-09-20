"""Tests for create_allowed_actions (port of packages/host-core/test/allowed-actions.test.ts, case by case)."""

from __future__ import annotations

import asyncio

from kohaku.host_core.allowed_actions import create_allowed_actions
from kohaku.spec import DomainPort, InvocationContext, JsonObject, OperationDescriptor


class _FakeDomain:
    """A minimal DomainPort stub whose list_operations() is scripted per test (structurally satisfies
    kohaku.spec.DomainPort)."""

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


_OPS = [
    OperationDescriptor(name="annotate", description="d"),
    OperationDescriptor(name="publish", description="d"),
]


def test_memoizes_list_operations_across_calls() -> None:
    domain: DomainPort = _FakeDomain([_OPS])

    async def run() -> None:
        allowed_actions = create_allowed_actions(domain)
        a = await allowed_actions()
        b = await allowed_actions()
        assert isinstance(domain, _FakeDomain)
        assert domain.calls == 1
        assert a is b
        assert sorted(a) == ["annotate", "publish"]

    asyncio.run(run())


def test_propagates_a_list_operations_rejection_to_the_caller_and_notifies_the_optional_on_error_hook() -> None:
    boom = RuntimeError("domain unavailable")
    domain: DomainPort = _FakeDomain([boom])
    seen: list[BaseException] = []

    async def run() -> None:
        allowed_actions = create_allowed_actions(domain, seen.append)
        try:
            await allowed_actions()
            raise AssertionError("expected allowed_actions() to raise")
        except RuntimeError as e:
            assert e is boom
        assert seen == [boom]

    asyncio.run(run())


def test_discards_the_cached_rejection_so_the_next_call_retries_against_the_domain_port() -> None:
    boom = RuntimeError("transient")
    domain_impl = _FakeDomain([boom, [OperationDescriptor(name="annotate", description="d")]])
    domain: DomainPort = domain_impl

    async def run() -> None:
        allowed_actions = create_allowed_actions(domain)
        try:
            await allowed_actions()
            raise AssertionError("expected the first call to raise")
        except RuntimeError:
            pass
        assert domain_impl.calls == 1
        retried = await allowed_actions()
        assert domain_impl.calls == 2
        assert sorted(retried) == ["annotate"]

    asyncio.run(run())

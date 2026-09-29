"""kohaku.host_core.operation_index — a memoized, validated index of a DomainPort's operations (port of
packages/host-core/src/operation-index.ts).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from kohaku.spec import (
    ActionParamsSchema,
    DomainPort,
    OperationDescriptor,
    assert_valid_action_params_schema,
)


@dataclass(frozen=True)
class OperationIndexEntry:
    """One `DomainPort` operation, indexed by name, with its `params_schema` (if any) pre-validated."""

    descriptor: OperationDescriptor
    params_schema: ActionParamsSchema | None = None
    """The descriptor's `paramsSchema`, already checked against kohaku's closed JSON Schema subset
    (design.md #62) -- None when the descriptor declared none (an action with no schema accepts any
    payload). Consumers (`create_action_gate`) validate a request's payload against this without
    re-checking the schema's own shape on every call."""


OperationIndex = Callable[[], Awaitable[dict[str, OperationIndexEntry]]]
"""A memoized, by-name index of a DomainPort's operations. See `create_operation_index`."""


def create_operation_index(
    domain: DomainPort, on_error: Callable[[BaseException], None] | None = None
) -> OperationIndex:
    """Builds a memoizing `OperationIndex` closure for one `DomainPort` — built once per host attach / deps
    object, mirroring `create_allowed_actions`'s own memoization contract (`list_operations()` is async and
    must not be re-awaited on every action invoke). Unlike `create_allowed_actions` (which only needs the
    *names* of a DomainPort's operations, for capability-scope filtering), this index keeps each operation's
    full descriptor plus its params schema, already validated for keyword-subset compliance (design.md #62)
    -- an operation whose `paramsSchema` uses a disallowed keyword raises `ActionParamsSchemaError` here, at
    index-build time (attach time), rather than on the first request that happens to invoke it.

    On rejection nothing is cached, so the next call retries against the DomainPort, and the rejection
    propagates to the caller — the same fail-fast-but-retryable contract as `create_allowed_actions`.
    `on_error` is a coarse, observability-only fallback fired (fire-and-forget, synchronously before the
    rejection propagates) on that same rejection.
    """
    cached: dict[str, OperationIndexEntry] | None = None

    async def operation_index() -> dict[str, OperationIndexEntry]:
        nonlocal cached
        if cached is not None:
            return cached
        try:
            ops = await domain.list_operations()
            index: dict[str, OperationIndexEntry] = {}
            for op in ops:
                params_schema = (
                    assert_valid_action_params_schema(op.name, op.paramsSchema)
                    if op.paramsSchema is not None
                    else None
                )
                index[op.name] = OperationIndexEntry(descriptor=op, params_schema=params_schema)
        except BaseException as e:
            if on_error is not None:
                on_error(e)
            raise
        cached = index
        return cached

    return operation_index


_background_validations: set[asyncio.Task[None]] = set()
"""Strong references to in-flight `start_operation_index_validation` tasks (the event loop only keeps weak
ones), dropped as each task finishes."""


def start_operation_index_validation(
    index: OperationIndex, report: Callable[[BaseException], Awaitable[None]]
) -> asyncio.Task[None] | None:
    """Builds `index` in the background so a failure (`list_operations()` raising, or a descriptor's
    `paramsSchema` outside kohaku's closed subset) is reported at attach time rather than only at the first
    request that hits it; `report` must not raise. The host attach functions are synchronous while
    `list_operations()` is async, so this needs a running event loop: without one it does nothing and returns
    None, and the index is then built lazily by the first request that needs it (unlike the TS hosts, which
    always have a microtask queue to start from). A rejected build is not memoized, so a later call retries.
    Counterpart of the TS hosts' eager `operationIndex()` call at attach."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None

    async def _run() -> None:
        try:
            await index()
        except Exception as exc:  # noqa: BLE001 -- reported, never raised out of the background task
            await report(exc)

    task = loop.create_task(_run())
    _background_validations.add(task)
    task.add_done_callback(_background_validations.discard)
    return task


__all__ = [
    "OperationIndex",
    "OperationIndexEntry",
    "create_operation_index",
    "start_operation_index_validation",
]

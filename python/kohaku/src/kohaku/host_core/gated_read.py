"""kohaku.host_core.gated_read — the guard every data-plane read runs before `DomainPort.invoke` (port of
packages/host-core/src/gated-read.ts).

SPEC ACT-RD-001, design.md #77. REST `/binding/resolve`, MCP `{prefix}_resolve_binding` and the MCP initial-data
pre-resolution look the ref's operation up in the memoized operation index and refuse an operation whose
declared tier is "confirm" or "approve": those run only through the governed action gate, never on a read
capability.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Literal

from kohaku.spec import action_payload_hash

from .action_gate_outcome import ActionAuditContext, record_action_gate_unavailable_denial
from .errors import fail_open
from .operation_index import OperationIndex, OperationIndexEntry

GATED_READ_MESSAGE = "gated operation is not readable"
"""Client-visible message (and `action.denied` audit reason) when a data-plane read names an operation whose
declared tier is "confirm" or "approve" (SPEC ACT-RD-001, design.md #77). Fixed on purpose, like the other
action-gate messages: REST answers 403 CAPABILITY_DENIED, MCP a plain `capability denied: ...` tool error."""


def gated_tier(entry: OperationIndexEntry) -> Literal["confirm", "approve"] | None:
    """The entry's declared tier when it is "confirm" or "approve", else None (tier-less and "auto" are not
    gated). The typed counterpart of TS `isGatedOperation`'s type guard."""
    tier = entry.descriptor.tier
    if tier == "confirm":
        return "confirm"
    if tier == "approve":
        return "approve"
    return None


def is_gated_operation(entry: OperationIndexEntry) -> bool:
    """True when `entry` is a governed Action that must go through the action gate (a declared tier of
    "confirm" or "approve"). A tier-less operation and tier "auto" are not gated. Port of TS
    `isGatedOperation`."""
    return gated_tier(entry) is not None


@dataclass(frozen=True)
class GatedReadReadable:
    """The operation is not gated (or is not in the index at all, as before): the host may invoke it."""

    kind: Literal["readable"] = "readable"


@dataclass(frozen=True)
class GatedReadGated:
    """The operation is gated; audited as `action.denied` with the descriptor's tier. The host must not invoke."""

    tier: Literal["confirm", "approve"]
    kind: Literal["gated"] = "gated"


@dataclass(frozen=True)
class GatedReadSchemaInvalid:
    """The operation is declared but its `params_schema` failed validation (`OperationIndexEntry.schema_error`);
    reported only, like the action path (nothing is audited). The host must not invoke (fail-closed for this
    operation alone)."""

    kind: Literal["schemaInvalid"] = "schemaInvalid"


@dataclass(frozen=True)
class GatedReadIndexUnavailable:
    """The operation index could not be read: reported and audited as `action.denied` (tier "auto") by the first
    read of this guard only. The host must not invoke (fail-closed)."""

    kind: Literal["indexUnavailable"] = "indexUnavailable"


type GatedReadOutcome = (
    GatedReadReadable | GatedReadGated | GatedReadSchemaInvalid | GatedReadIndexUnavailable
)

GatedReadGuard = Callable[[str, ActionAuditContext], Awaitable[GatedReadOutcome]]
"""Checks one read of `operation` (the op name a `query://` ref's path names, passed explicitly -- never taken
from `audit.action`, which is overwritten with it). `audit` supplies the principal, tenant, recorder and
correlation id for the `action.denied` record and `payload` the invoke params it is hashed from."""


def create_gated_read_guard(
    *,
    operation_index: OperationIndex,
    report_index_failure: Callable[[BaseException], Awaitable[None]],
    report_schema_error: Callable[[BaseException], Awaitable[None]],
) -> GatedReadGuard:
    """Builds the guard every data-plane read runs before `DomainPort.invoke`: looks the ref's operation up in the
    memoized operation index and refuses it when it is gated. Fail-closed when the index cannot be read, on the
    same footing as the action path (SPEC ACT-APR-001), and when the operation's declaration is invalid
    (`schema_error`, the action path's schemaInvalid); a gated operation is refused as gated even when its schema
    is invalid. An operation absent from the index stays readable -- read refs name query operations that a
    `DomainPort` need not list, and nothing there declares a tier to enforce. The audit records are fail-open.

    One guard reads the index once: if that read fails, the first read through the guard reports it
    (`report_index_failure`) and audits `action.denied` (tier "auto"), and every other read through the same
    guard gets indexUnavailable silently, so a pre-resolution of N refs over a dead `list_operations()` yields
    one report and one audit record, not N. A schema error is reported once per operation. Port of TS
    `createGatedReadGuard`."""
    index_read: asyncio.Future[dict[str, OperationIndexEntry]] | None = None
    index_failure_handled = False
    schema_errors_reported: set[str] = set()

    async def guard(operation: str, audit: ActionAuditContext) -> GatedReadOutcome:
        nonlocal index_read, index_failure_handled
        ctx = replace(audit, action=operation)
        if index_read is None:
            index_read = asyncio.ensure_future(operation_index())
        try:
            # shield: a caller cancelled (a per-ref timeout) must not cancel the read the others share.
            index = await asyncio.shield(index_read)
        except Exception as e:  # noqa: BLE001 -- any index failure is the fail-closed outcome
            if not index_failure_handled:
                index_failure_handled = True
                await report_index_failure(e)
                await record_action_gate_unavailable_denial(ctx)
            return GatedReadIndexUnavailable()
        entry = index.get(operation)
        if entry is None:
            return GatedReadReadable()
        tier = gated_tier(entry)
        if tier is not None:
            await _record_gated_read_denial(ctx, tier)
            return GatedReadGated(tier=tier)
        if entry.schema_error is not None:
            if operation not in schema_errors_reported:
                schema_errors_reported.add(operation)
                await report_schema_error(entry.schema_error)
            return GatedReadSchemaInvalid()
        return GatedReadReadable()

    return guard


async def run_gated_read_guard(
    *,
    operation_index: OperationIndex,
    operation: str,
    audit: ActionAuditContext,
    report_index_failure: Callable[[BaseException], Awaitable[None]],
    report_schema_error: Callable[[BaseException], Awaitable[None]],
) -> GatedReadOutcome:
    """The one-shot form of `create_gated_read_guard`, for a host that reads a single ref per request. Port of
    TS `runGatedReadGuard`."""
    guard = create_gated_read_guard(
        operation_index=operation_index,
        report_index_failure=report_index_failure,
        report_schema_error=report_schema_error,
    )
    return await guard(operation, audit)


async def _record_gated_read_denial(
    ctx: ActionAuditContext, tier: Literal["confirm", "approve"]
) -> None:
    """Records `action.denied` for a data-plane read refused because the ref names a gated operation (reason
    GATED_READ_MESSAGE, tier = the descriptor's). Fail-open like the other recorders in
    `action_gate_outcome`."""
    recorder = ctx.recorder

    async def _record() -> None:
        if recorder is None:
            return
        await recorder.denied(
            action=ctx.action,
            payload_hash=action_payload_hash(ctx.payload),
            tier=tier,
            reason=GATED_READ_MESSAGE,
            principal=ctx.principal,
            tenant=ctx.tenant,
            correlation_id=ctx.correlation_id,
        )

    await fail_open(_record, ctx.report)


__all__ = [
    "GATED_READ_MESSAGE",
    "GatedReadGated",
    "GatedReadGuard",
    "GatedReadIndexUnavailable",
    "GatedReadOutcome",
    "GatedReadReadable",
    "GatedReadSchemaInvalid",
    "create_gated_read_guard",
    "gated_tier",
    "is_gated_operation",
    "run_gated_read_guard",
]

"""kohaku.host_core.gated_read — the guard every data-plane read runs before `DomainPort.invoke` (port of
packages/host-core/src/gated-read.ts).

SPEC ACT-RD-001, design.md #77. REST `/binding/resolve`, MCP `{prefix}_resolve_binding` and the MCP initial-data
pre-resolution look the ref's operation up in the memoized operation index and refuse an operation whose
declared tier is "confirm" or "approve": those run only through the governed action gate, never on a read
capability.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

from kohaku.spec import action_payload_hash

from .action_gate_outcome import ActionAuditContext, record_action_gate_unavailable_denial
from .errors import fail_open
from .operation_index import OperationIndex, OperationIndexEntry

GATED_READ_MESSAGE = "gated operation is not readable"
"""Client-visible message (and `action.denied` audit reason) when a data-plane read names an operation whose
declared tier is "confirm" or "approve" (SPEC ACT-RD-001, design.md #77). Fixed on purpose, like the other
action-gate messages: REST answers 403 CAPABILITY_DENIED, MCP a plain `capability denied: ...` tool error."""


def is_gated_operation(entry: OperationIndexEntry) -> bool:
    """True when `entry` is a governed Action that must go through the action gate (a declared tier of
    "confirm" or "approve"). A tier-less operation and tier "auto" are not gated. Port of TS
    `isGatedOperation`."""
    return entry.descriptor.tier in ("confirm", "approve")


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
class GatedReadIndexUnavailable:
    """The operation index could not be read: reported, audited as `action.denied` (tier "auto"). The host must
    not invoke (fail-closed)."""

    kind: Literal["indexUnavailable"] = "indexUnavailable"


type GatedReadOutcome = GatedReadReadable | GatedReadGated | GatedReadIndexUnavailable


async def run_gated_read_guard(
    *,
    operation_index: OperationIndex,
    audit: ActionAuditContext,
    report_index_failure: Callable[[BaseException], Awaitable[None]],
) -> GatedReadOutcome:
    """Looks the read ref's operation (`audit.action`) up in the memoized operation index and refuses it when it
    is gated. Fail-closed when the index cannot be read, on the same footing as the action path (SPEC
    ACT-APR-001): `report_index_failure` is awaited, then `action.denied` (tier "auto") is audited. An operation
    absent from the index stays readable -- read refs name query operations that a `DomainPort` need not list,
    and nothing there declares a tier to enforce. The audit records are fail-open. Port of TS
    `runGatedReadGuard`."""
    try:
        index = await operation_index()
    except Exception as e:  # noqa: BLE001 -- any index failure is the fail-closed outcome
        await report_index_failure(e)
        await record_action_gate_unavailable_denial(audit)
        return GatedReadIndexUnavailable()
    entry = index.get(audit.action)
    if entry is None or not is_gated_operation(entry):
        return GatedReadReadable()
    tier: Literal["confirm", "approve"] = (
        "approve" if entry.descriptor.tier == "approve" else "confirm"
    )
    recorder = audit.recorder

    async def _record() -> None:
        if recorder is None:
            return
        await recorder.denied(
            action=audit.action,
            payload_hash=action_payload_hash(audit.payload),
            tier=tier,
            reason=GATED_READ_MESSAGE,
            principal=audit.principal,
            tenant=audit.tenant,
            correlation_id=audit.correlation_id,
        )

    await fail_open(_record, audit.report)
    return GatedReadGated(tier=tier)


__all__ = [
    "GATED_READ_MESSAGE",
    "GatedReadGated",
    "GatedReadIndexUnavailable",
    "GatedReadOutcome",
    "GatedReadReadable",
    "is_gated_operation",
    "run_gated_read_guard",
]

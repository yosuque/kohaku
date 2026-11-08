"""Self-healing that loses a storage compare-and-set race is a no-op, not an error (port of the host-core
fixation.test.ts case): another instance already healed the fixation, so nothing is reported to the host's
self-heal reporter."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, cast

from kohaku.composer import ComposeResult, FixationCheck
from kohaku.host_core import FixationDeliveryHost, FixationTarget, settle_fixation
from kohaku.spec import FixationRecord, Principal, StorageConflictError, UISpec

from ..lineage._helpers import l1_spec


class _ConflictingFixations:
    def __init__(self) -> None:
        self.refresh_calls = 0
        self.invalidate_calls = 0

    async def refresh_fingerprint(self, *args: Any, **kwargs: Any) -> None:
        self.refresh_calls += 1
        raise StorageConflictError("fixation", "h")

    async def invalidate(self, *args: Any, **kwargs: Any) -> None:
        self.invalidate_calls += 1
        raise StorageConflictError("fixation", "h")


def test_a_storage_conflict_in_refresh_fingerprint_or_invalidate_is_not_reported() -> None:
    reported: list[BaseException] = []

    async def run_self_heal(
        tenant: str | None,
        intent_hash: str,
        fn: Callable[[], Awaitable[None]],
        kind: str,
    ) -> None:
        try:
            await fn()
        except Exception as e:
            reported.append(e)

    fixations = _ConflictingFixations()
    host = FixationDeliveryHost(run_self_heal=run_self_heal, fixations=fixations)
    spec: UISpec = l1_spec()
    fixation = FixationRecord(
        intentHash=spec.intent.hash,
        canonical="sales.trend",
        structureHash="sha256:" + "1" * 64,
        pinnedSpec=spec,
        fixatedAt="2026-07-01T00:00:00Z",
        approver=Principal(id="tester"),
        revision="r1",
    )
    target = FixationTarget(
        intent_hash=spec.intent.hash,
        tenant=None,
        catalog_fingerprint="fp",
        fixation=fixation,
    )

    async def run() -> None:
        await settle_fixation(
            (cast("Any", object()), FixationCheck(kind="revalidated")), target, host
        )
        await settle_fixation((None, FixationCheck(kind="stale", issues=["x"])), target, host)

    asyncio.run(run())

    assert (fixations.refresh_calls, fixations.invalidate_calls) == (1, 1)
    assert reported == []


def test_an_unavailable_check_returns_none_without_invalidating_and_reports_the_cause() -> None:
    """The pin's filter check could not run (descriptor source raised): this request falls back to normal
    compose, the approved fixation is NOT invalidated, and the cause reaches the host's reporter with kind "check"
    (port of the host-core fixation.test.ts unavailable cases)."""
    reported: list[tuple[str, BaseException]] = []

    async def run_self_heal(
        tenant: str | None,
        intent_hash: str,
        fn: Callable[[], Awaitable[None]],
        kind: str,
    ) -> None:
        try:
            await fn()
        except Exception as e:
            reported.append((kind, e))

    fixations = _ConflictingFixations()
    host = FixationDeliveryHost(run_self_heal=run_self_heal, fixations=fixations)
    spec: UISpec = l1_spec()
    fixation = FixationRecord(
        intentHash=spec.intent.hash,
        canonical="sales.trend",
        structureHash="sha256:" + "1" * 64,
        pinnedSpec=spec,
        fixatedAt="2026-07-01T00:00:00Z",
        approver=Principal(id="tester"),
    )
    target = FixationTarget(
        intent_hash=spec.intent.hash, tenant=None, catalog_fingerprint="fp", fixation=fixation
    )
    cause = RuntimeError("describe_filters down")

    async def run() -> ComposeResult | None:
        first = await settle_fixation(
            (None, FixationCheck(kind="unavailable", issues=["x"], cause=cause)), target, host
        )
        # No cause carried: an error built from the issues is reported instead.
        await settle_fixation(
            (None, FixationCheck(kind="unavailable", issues=["a", "b"])), target, host
        )
        return first

    assert asyncio.run(run()) is None
    assert fixations.invalidate_calls == 0
    assert [(k, e) for k, e in reported][0] == ("check", cause)
    assert reported[1][0] == "check" and str(reported[1][1]) == "a; b"

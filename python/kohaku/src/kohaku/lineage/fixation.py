"""L1 -> L0 fixation (Port of TS packages/lineage/src/fixation/service.ts).

Applying the effect is handled by host-rest's fixationLookup short-circuit; the composer needs no changes.
Thanks to $ref reference-passing, even with the structure fixed the data is always the latest.

Differences from TS:
- Detecting that deleteFixation is "not implemented": TS decides via `storage.deleteFixation == null`, but
  Python's StoragePort always declares delete_fixation, and an unsupported implementation raises
  NotImplementedError by contract (spec/ports.py). So we call delete_fixation and convert NotImplementedError
  into FixationUnsupportedError. Because the audit event is recorded **after** the deletion succeeds, when it is
  unsupported neither state nor audit remains (same behavior as TS).
- computeStructureHash is a synchronous function of kohaku.spec. Time is injectable via the clock argument (default now_iso).
"""

from __future__ import annotations

import dataclasses
import math
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from kohaku.spec import (
    FixationRecord,
    GovernanceErrorDiscriminators,
    LineageActor,
    LineageFilter,
    Principal,
    StoragePort,
    UISpec,
    compute_structure_hash,
    validate_fixation_record,
)

from .events import Clock, now_iso
from .lineage import Lineage

FixationErrorEndpoint = Literal["storage.record.invalid"]
"""The single call site `Fixations`' `on_error` hook fires from (port of TS FixationErrorEndpoint): a
fixation record read back from `StoragePort.get_fixation` (by `unfixate` / `invalidate` /
`refresh_fingerprint`) failed `kohaku.spec.validate_fixation_record` (§4.3 A10 of the 2026-09 review — a
corrupted or hand-edited `fixations.json` entry). The reader treats the record as absent (the same branch a
real `None` takes), so a broken `pinnedSpec` never reaches the delivery path; this hook only reports that it
happened."""


@dataclass(frozen=True)
class FixationErrorContext:
    """Context passed to `Fixations`' `on_error` hook alongside the causing exception."""

    endpoint: FixationErrorEndpoint
    intentHash: str
    tenant: str | None = None


OnFixationError = Callable[[FixationErrorContext, BaseException], None]


def _notify_fixation_error(
    on_error: OnFixationError | None, ctx: FixationErrorContext, error: BaseException
) -> None:
    """Fires on_error fire-and-forget, swallowing any synchronous exception from the hook itself (an
    observation-only hook must never mask or replace the caller's own error/result). Deliberately local
    (not shared with promotion/service.py's _notify_promotion_error) because the two modules' contexts
    differ in shape (intentHash vs. artifactId), mirroring TS's fixation/service.ts."""
    if on_error is None:
        return
    try:
        on_error(ctx, error)
    except Exception:  # noqa: BLE001,S110 — swallowed: observability must not affect control flow
        pass


class FixationUnsupportedError(Exception):
    """Fail-fast error raised when unfixate is called on a StoragePort that does not implement deleteFixation."""

    code = GovernanceErrorDiscriminators.FIXATION_UNSUPPORTED_CODE

    def __init__(
        self, message: str = "unfixate requires a StoragePort.delete_fixation implementation"
    ) -> None:
        super().__init__(message)
        self.name = "FixationUnsupportedError"


class SupportsFingerprint(Protocol):
    """The object returned by catalog_for (supplies the current catalog's fingerprint).

    Declared as a read-only property so that any object with a fingerprint attribute
    (registry.ResolvedCatalog / a frozen dataclass, etc.) can satisfy it structurally.
    """

    @property
    def fingerprint(self) -> str: ...


@dataclass(frozen=True)
class FixationPolicy:
    minUses: int = 50
    minDistinctSessions: int = 10
    structuralStability: float = 0.95
    """Threshold for the ratio of the most frequent structureHash (structural stability)."""


DEFAULT_FIXATION_POLICY = FixationPolicy()


@dataclass(frozen=True)
class FixationProposal:
    intentHash: str
    canonical: str
    uses: int
    sessions: int
    stability: float
    tier: str
    params: dict[str, Any] | None = None


@dataclass
class _IntentAcc:
    canonical: str
    tier: str
    params: dict[str, Any] | None = None
    uses: int = 0
    sessions: set[str] = field(default_factory=set)
    structures: dict[str, int] = field(default_factory=dict)


_BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def _to_base36(n: int) -> str:
    """Mirrors JS's `Number.prototype.toString(36)` for a non-negative integer (used only by
    _generate_revision; no need to handle negative numbers)."""
    if n == 0:
        return "0"
    digits: list[str] = []
    while n > 0:
        n, rem = divmod(n, 36)
        digits.append(_BASE36_ALPHABET[rem])
    return "".join(reversed(digits))


def _generate_revision() -> str:
    """Generates a coarse ulid-like, per-write revision token (port of TS's generateRevision): a base36 ms
    timestamp plus a random suffix. Not the full `ulid` scheme (no cross-service sortability guarantee is
    needed here) — only "distinguishable from the previous write even inside the same millisecond" matters,
    which fixatedAt (an ms-precision ISO timestamp) cannot provide (D7: an unfixate -> fixate pair landing in
    the same ms would otherwise share a TOCTOU guard token with the fixation it replaced)."""
    return f"{_to_base36(int(time.time() * 1000))}-{_to_base36(random.getrandbits(40))}"


class Fixations:
    """Public API for extracting fixation candidates, fixating, unfixating, self-healing invalidation, and re-stamping the fingerprint."""

    def __init__(
        self,
        *,
        lineage: Lineage,
        storage: StoragePort,
        policy: FixationPolicy | None = None,
        catalog_for: Callable[[str | None], SupportsFingerprint] | None = None,
        clock: Clock = now_iso,
        on_error: OnFixationError | None = None,
    ) -> None:
        self._lineage = lineage
        self._storage = storage
        self._policy = policy if policy is not None else DEFAULT_FIXATION_POLICY
        self._catalog_for = catalog_for
        self._clock = clock
        self._on_error = on_error

    async def _get_validated_fixation(
        self, intent_hash: str, tenant: str | None
    ) -> FixationRecord | None:
        """Reads a fixation and validates it (kohaku.spec.validate_fixation_record), treating a validation
        failure exactly like a real absence. Shared by unfixate / invalidate / refresh_fingerprint, the three
        call sites that read a fixation back from storage in this service (the delivery-path read,
        materialize_fixation, is validated independently by the composer)."""
        raw = await self._storage.get_fixation(intent_hash, tenant)
        if raw is None:
            return None
        validated = validate_fixation_record(raw)
        if validated is not None:
            return validated
        _notify_fixation_error(
            self._on_error,
            FixationErrorContext(endpoint="storage.record.invalid", intentHash=intent_hash, tenant=tenant),
            ValueError(f"fixation record for {intent_hash} failed schema validation"),
        )
        return None

    async def proposals(self, *, tenant: str | None = None) -> list[FixationProposal]:
        """Extract fixation candidates from frequently-used Intents (L1). tenant narrows the aggregation and already-fixated check."""
        # Aggregation covers only the most recent 5000 view.composed events. Anything beyond is dropped (a known constraint).
        composed = await self._storage.list_lineage(
            LineageFilter(type=["view.composed"], limit=5000, tenant=tenant)
        )
        fixated = {f.intentHash for f in await self._storage.list_fixations(tenant)}

        by_intent: dict[str, _IntentAcc] = {}
        for event in composed:
            tier = str(event.payload.get("tier") or "")
            # L2 is the promotion pipeline's domain, L0 is already fixated — only L1 is subject to fixation
            if tier != "L1":
                continue
            intent_hash = str(event.payload.get("intentHash") or "")
            if intent_hash == "" or intent_hash in fixated:
                continue
            acc = by_intent.get(intent_hash)
            if acc is None:
                params = event.payload.get("params")
                acc = _IntentAcc(
                    canonical=str(event.payload.get("canonical") or ""),
                    tier=tier,
                    params=params if isinstance(params, dict) else None,
                )
                by_intent[intent_hash] = acc
            acc.uses += 1
            session_id = event.payload.get("sessionId")
            if isinstance(session_id, str):
                acc.sessions.add(session_id)
            structure_hash = event.payload.get("structureHash")
            if isinstance(structure_hash, str):
                acc.structures[structure_hash] = acc.structures.get(structure_hash, 0) + 1

        proposals: list[FixationProposal] = []
        for intent_hash, acc in by_intent.items():
            structure_counts = list(acc.structures.values())
            total = sum(structure_counts)
            stability = (max(structure_counts) / total) if total > 0 else 1
            sessions = max(len(acc.sessions), 1 if acc.uses > 0 else 0)
            if (
                acc.uses >= self._policy.minUses
                and sessions >= self._policy.minDistinctSessions
                and stability >= self._policy.structuralStability
            ):
                proposals.append(
                    FixationProposal(
                        intentHash=intent_hash,
                        canonical=acc.canonical,
                        params=acc.params,
                        uses=acc.uses,
                        sessions=sessions,
                        # Match JS Math.round (positive values round half up), avoiding banker's rounding.
                        stability=math.floor(stability * 1000 + 0.5) / 1000,
                        tier=acc.tier,
                    )
                )
        return sorted(proposals, key=lambda p: p.uses, reverse=True)

    async def list_fixations(self, *, tenant: str | None = None) -> list[FixationRecord]:
        """List of already-fixated entries. When tenant is given, only that tenant's entries (unset = all).

        Corresponds to TS's Fixations.list. Renamed to list_fixations to avoid clashing with the built-in `list`.
        """
        return await self._storage.list_fixations(tenant)

    async def fixate(
        self, *, pinned_spec: UISpec, approver: Principal, tenant: str | None = None
    ) -> FixationRecord:
        """Human-approved fixation. The structure of pinned_spec is thereafter served as L0."""
        record = FixationRecord(
            intentHash=pinned_spec.intent.hash,
            canonical=pinned_spec.intent.canonical,
            structureHash=compute_structure_hash(pinned_spec),
            pinnedSpec=pinned_spec,
            fixatedAt=self._clock(),
            revision=_generate_revision(),
            approver=approver,
            # Stamp this tenant's catalog fingerprint at fixation time (the fast-path basis for materialize's staleness detection).
            catalogFingerprint=(
                self._catalog_for(tenant).fingerprint if self._catalog_for is not None else None
            ),
            tenant=tenant,
        )
        await self._storage.put_fixation(record)
        await self._lineage.record(
            "intent.fixated",
            {
                "intentHash": record.intentHash,
                "canonical": record.canonical,
                "structureHash": record.structureHash,
                "approver": approver.id,
            },
            LineageActor(kind="user", id=approver.id),
            tenant,
        )
        return record

    async def unfixate(
        self, intent_hash: str, approver: Principal, tenant: str | None = None
    ) -> None:
        existing = await self._get_validated_fixation(intent_hash, tenant)
        if existing is None:
            return
        # Do the state change (deletion) first, and record the audit event only on success (the event log is the source of truth).
        # An unimplemented deleteFixation surfaces as NotImplementedError -> convert to FixationUnsupportedError and fail-fast.
        try:
            await self._storage.delete_fixation(intent_hash, tenant)
        except NotImplementedError as e:
            raise FixationUnsupportedError() from e
        await self._lineage.record(
            "intent.unfixated",
            {"intentHash": intent_hash, "approver": approver.id},
            LineageActor(kind="user", id=approver.id),
            tenant,
        )

    async def invalidate(
        self,
        intent_hash: str,
        reason: str,
        detail: str | None = None,
        tenant: str | None = None,
        guard: dict[str, Any] | None = None,
    ) -> None:
        """Self-healing invalidation of a stale fixation. The host calls this when materialize's revalidation is stale.

        guard["ifRevision"] (optional): the fixation's monotonic revision token at the time of the stale
        decision. When present, this takes priority over guard["ifFixatedAt"] — unlike fixatedAt's ms-precision
        ISO timestamp, revision distinguishes an unfixate -> fixate pair landing inside the same millisecond.
        guard["ifFixatedAt"]: the fixatedAt timestamp of the fixation at the time of the stale decision. Should
        always be supplied by callers (including for legacy records with no catalogFingerprint or revision), so
        a fixation re-approved between the decision and this call is never swept up even without a fingerprint
        or a revision. guard["ifCatalogFingerprint"] (optional): additionally compares the catalog fingerprint
        when the fixation has one. If any of these does not match the current fixation (= a different fixation
        re-approved after the decision), do not delete (TOCTOU guard).
        """
        existing = await self._get_validated_fixation(intent_hash, tenant)
        if existing is None:
            return
        # TOCTOU guard: if the fixation at the stale-decision time and the current fixation differ, do not delete.
        if guard is not None:
            if_revision = guard.get("ifRevision")
            if if_revision is not None:
                if existing.revision != if_revision:
                    return
            else:
                if_fixated_at = guard.get("ifFixatedAt")
                if if_fixated_at is not None and existing.fixatedAt != if_fixated_at:
                    return
            if_fingerprint = guard.get("ifCatalogFingerprint")
            if if_fingerprint is not None and existing.catalogFingerprint != if_fingerprint:
                return
        try:
            await self._storage.delete_fixation(intent_hash, tenant)
        except NotImplementedError as e:
            raise FixationUnsupportedError() from e
        # Since this is self-healing invalidation, the actor is system (distinguished from human-approved unfixate).
        payload: dict[str, Any] = {"intentHash": intent_hash, "reason": reason}
        if detail is not None:
            payload["detail"] = detail
        await self._lineage.record(
            "intent.unfixated", payload, LineageActor(kind="system"), tenant
        )

    async def refresh_fingerprint(
        self, intent_hash: str, catalog_fingerprint: str, tenant: str | None = None
    ) -> None:
        """Re-stamp a fixation that passed revalidation with the current catalog fingerprint.

        Only overwrites via put_fixation and records no audit event (this resolves state staleness, it is not a governance decision).
        """
        existing = await self._get_validated_fixation(intent_hash, tenant)
        if existing is None:
            return
        # Overwrites while preserving existing.tenant, so put_fixation writes back to the same key.
        # if_present=True: self-healing fires fire-and-forget from the compose path, so between this call's
        # get and put another writer (a management-plane unfixate, or another process sharing storage) may
        # have deleted the fixation. Without a conditional write, put would resurrect it from this stale
        # in-memory copy; if_present makes the write a no-op unless the fixation still exists on disk.
        await self._storage.put_fixation(
            dataclasses.replace(existing, catalogFingerprint=catalog_fingerprint),
            if_present=True,
        )


def create_fixations(
    *,
    lineage: Lineage,
    storage: StoragePort,
    policy: FixationPolicy | None = None,
    catalog_for: Callable[[str | None], SupportsFingerprint] | None = None,
    clock: Clock | None = None,
    on_error: OnFixationError | None = None,
) -> Fixations:
    return Fixations(
        lineage=lineage,
        storage=storage,
        policy=policy,
        catalog_for=catalog_for,
        clock=clock if clock is not None else now_iso,
        on_error=on_error,
    )

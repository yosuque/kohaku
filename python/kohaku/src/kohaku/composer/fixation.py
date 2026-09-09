"""Building the Spec / trace on a fixation (L1→L0) hit (port of TS fixation.ts).

provenance.cache="fixated" / trace.cache="fixated" / cacheKey / tier="L0" is the norm for
"cross-surface identical display" (spec/SPEC.md). Writing it per host would silently break when one
side changes, so it is consolidated in the composer to guarantee identical materialization across all surfaces.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal

from kohaku.spec import (
    FixationRecord,
    Intent,
    QueryHandle,
    UISpec,
    combine_data_versions,
    validate_fixation_record,
)

from .compose import ComposeResult
from .context import ComposeContext
from .trace import ComposeTrace


@dataclass(frozen=True)
class FixationCheck:
    """Result of the staleness check when delivering a fixation (L0).

    - fresh: the catalog fingerprint at fixation time matches the current one → deliver as-is, skipping revalidation.
    - revalidated: the fingerprint mismatches/is missing, but revalidation against the current catalog passes → deliverable.
    - stale: validation against the current catalog fails → not deliverable (the host invalidates the fixation and
      falls back to normal compose).
    """

    kind: Literal["fresh", "revalidated", "stale"]
    issues: list[str] | None = None


async def materialize_fixation(
    fixation: FixationRecord,
    intent: Intent,
    ctx: ComposeContext,
    tenant: str | None = None,
) -> tuple[ComposeResult | None, FixationCheck]:
    """Builds the Spec / trace on a fixation hit.

    Staleness detection: because pinnedSpec is the structure at fixation time, if the catalog subsequently
    changes it would keep delivering a broken structure. lineage recording is not done in the composer
    (recording is the host layer's responsibility).
    """
    # Storage-boundary validation (§4.3 A10 of the 2026-09 review): a corrupted or non-conforming fixation
    # record (most importantly a broken pinnedSpec) must never be delivered just because it happens to
    # carry a matching catalog fingerprint — the fingerprint fast path below only ever compares a *string*,
    # so it cannot itself catch a structurally broken pinnedSpec. Treated as "not deliverable" (the host's
    # self-healing then rediscovers the same corruption independently the next time it reads this record
    # through kohaku.lineage's own validate_fixation_record-validated getter).
    validated = validate_fixation_record(fixation)
    if validated is None:
        return None, FixationCheck(
            kind="stale",
            issues=["fixation record failed schema validation"],
        )
    fixation = validated

    # Fingerprint fast path: if the catalog fingerprint at fixation time matches the current one, treat the structure as unchanged and skip validation.
    if fixation.catalogFingerprint == ctx.catalog.fingerprint:
        check = FixationCheck(kind="fresh")
    else:
        result = ctx.catalog.validate(
            [c.to_wire() for c in fixation.pinnedSpec.components],
            [e.to_wire() for e in fixation.pinnedSpec.events],
        )
        if len(result.issues) > 0:
            return None, FixationCheck(
                kind="stale",
                issues=[f"{i.componentId}: {i.message}" for i in result.issues],
            )
        check = FixationCheck(kind="revalidated")

    resolved = await ctx.semantic.resolve_query(intent, tenant=tenant)
    handles: list[QueryHandle] = resolved if isinstance(resolved, list) else [resolved]
    versions = list(await asyncio.gather(*(ctx.semantic.data_version(h) for h in handles)))
    versions_by_ref = {h.uri: versions[i] for i, h in enumerate(handles)}

    # Reinforcement of staleness detection (multi-ref): confirm that the fixed Spec matches the current
    # Intent's "resolved URI set". Because catalogFingerprint derives from the catalog and is independent of
    # the query mapping, drift in the resolved URI set cannot be caught by the fingerprint fast path or by
    # revalidation. Err on the safe side and treat it as stale.
    drift = _detect_ref_drift(fixation, list(versions_by_ref.keys()))
    if drift is not None:
        kind, uri = drift
        return None, FixationCheck(
            kind="stale",
            issues=[f"The fixed Spec's reference set does not match the current Intent's resolution result ({kind}: {uri})"],
        )

    # pinnedSpec's refVersions is the old version at fixation time, so always drop it and re-fill with the latest version.
    # Delivering it as-is would make the renderer's per-reference matching always STALE.
    data_version = combine_data_versions([(h.uri, versions[i]) for i, h in enumerate(handles)])
    pinned_wire = fixation.pinnedSpec.to_wire()
    pinned_wire.pop("refVersions", None)
    pinned_wire.update(
        {
            "intent": intent.to_wire(),
            "dataVersion": data_version,
            **({"refVersions": versions_by_ref} if len(handles) > 0 else {}),
            "provenance": {
                **pinned_wire["provenance"],
                "tier": "L0",
                "cache": "fixated",
            },
        }
    )
    spec = UISpec.model_validate(pinned_wire)
    trace = ComposeTrace(
        input="intent",
        intent=intent,
        refs=[h.uri for h in handles],
        dataVersion=spec.dataVersion,
        cacheKey=f"fixated:{intent.hash}",
        # Distinguish a fixation short-circuit from a normal cache hit (consistent with provenance.cache="fixated").
        cache="fixated",
        tier="L0",
        attempts=[],
        durationMs=0,
    )
    return ComposeResult(spec=spec, trace=trace), check


def _detect_ref_drift(
    fixation: FixationRecord, resolved_uris: list[str]
) -> tuple[Literal["added", "removed", "orphan"], str] | None:
    """Returns one drift item (with direction) between the fixed Spec's reference set and the current resolved URI set.

    - with refVersions: that key set is the resolved URI set at fixation time. Take the bidirectional
      difference and return an addition (added) preferentially.
    - refVersions missing (an old record): confirm only, in one direction, that the pinned components' $ref
      are covered by the current resolved URIs (best-effort / orphan).
    """
    pinned_ref_versions = fixation.pinnedSpec.refVersions
    if pinned_ref_versions is not None:
        added = next((uri for uri in resolved_uris if uri not in pinned_ref_versions), None)
        if added is not None:
            return ("added", added)
        removed = next((uri for uri in pinned_ref_versions if uri not in resolved_uris), None)
        if removed is not None:
            return ("removed", removed)
        return None
    orphan = next(
        (
            c.data.ref
            for c in fixation.pinnedSpec.components
            if c.data is not None and c.data.ref not in resolved_uris
        ),
        None,
    )
    return ("orphan", orphan) if orphan is not None else None

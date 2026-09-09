"""The core of View / Component Lineage recording (Port of TS packages/lineage/src/lineage.ts).

Differences from TS:
- createLineage's newId (default ulid) is injectable via the new_id argument (the default is a homegrown
  ULID = the same textual format as TS's ulid). A sortable ID whose lexicographic order advances with time,
  so visual audit tracing and chronological ordering match across languages.
- Time generation is injectable via the clock argument (default now_iso).
- computeSpecHash / computeStructureHash are synchronous functions of kohaku.spec (the existing port's style).
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import Any, Protocol

from kohaku.spec import (
    JsonObject,
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    StoragePort,
    Surface,
    UISpec,
    compute_spec_hash,
    compute_structure_hash,
)

from .events import COMPONENT_EVENT_TYPES, Clock, make_event, now_iso


class ComposeTraceLike(Protocol):
    """The compose trace passed to view_composed.

    TS's ComposeTraceLike declares intent / dataVersion / cache / tier / model / durationMs, but at runtime
    view_composed references only durationMs (tier / cache / model etc. are taken from spec.provenance). This
    port requires only durationMs and leaves the rest to structural matching (composer.ComposeTrace satisfies it).
    Declared as a read-only property so a frozen dataclass (a test's FakeTrace, etc.) can also satisfy it.
    """

    @property
    def durationMs(self) -> float: ...


def artifact_id_of(sha256: str) -> str:
    return f"art-{sha256[:12]}"


# Crockford Base32 (ULID spec. 32 chars excluding I/L/O/U. ASCII ascending = value ascending, so lexicographic order matches value order).
_CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _ulid() -> str:
    """Generate a ULID (48-bit ms timestamp + 80-bit randomness, 26 chars of Crockford Base32).

    The same textual format as TS's ulid library (a homegrown implementation with no added dependency) = 26
    uppercase Crockford Base32 chars. Since the first 10 chars are the timestamp, a different ms means the
    lexicographic order matches time order (monotonicity is not guaranteed = the order within the same ms is
    undefined; TS's plain ulid() is the same). Spec: https://github.com/ulid/spec
    """
    timestamp = int(time.time() * 1000) & ((1 << 48) - 1)
    randomness = int.from_bytes(os.urandom(10), "big")  # 80-bit
    value = (timestamp << 80) | randomness  # 128-bit (low 80 bits = randomness / next 48 bits = timestamp)
    chars = [""] * 26
    # Take 5 bits at a time from the low end (chars[10:26] = randomness / chars[0:10] = timestamp. 26*5=130 bits,
    # so the top 2 bits are 0-padded).
    for i in range(25, -1, -1):
        chars[i] = _CROCKFORD_BASE32[value & 0x1F]
        value >>= 5
    return "".join(chars)


def _default_id() -> str:
    return _ulid()


class Lineage:
    """Appends arbitrary events, plus the high-level recording API for View / Component Lineage."""

    def __init__(
        self,
        storage: StoragePort,
        *,
        new_id: Callable[[], str] = _default_id,
        clock: Clock = now_iso,
    ) -> None:
        self._storage = storage
        self._new_id = new_id
        self._clock = clock
        # An in-process cache to skip the component.generated duplicate check (3-12a).
        # Remembers that "this recorder has already recorded / existence-checked the generated for (tenant, artifactId)."
        # The key is a NUL-separated composite (tenant\x00artifactId; unset tenant is the empty string). It has no
        # eviction and grows monotonically in proportion to the number of distinct (tenant, artifactId) (a known
        # constraint; production assumes a dedicated event store).
        self._known_generated_ids: set[str] = set()

    async def record(
        self,
        type: str,
        payload: dict[str, Any],
        actor: LineageActor | None = None,
        tenant: str | None = None,
    ) -> LineageEventRecord:
        """Append an arbitrary event (higher-level APIs such as the promotion pipeline also use this).

        Passing tenant stamps it into LineageEventRecord.tenant (appears on the wire only when non-None).
        """
        event = make_event(self._new_id(), type, payload, actor, tenant, clock=self._clock)
        await self._storage.append_lineage(event)
        return event

    async def view_composed(
        self,
        *,
        spec: UISpec,
        trace: ComposeTraceLike,
        surface: Surface,
        session_id: str | None = None,
        tenant: str | None = None,
        spec_hash: str | None = None,
        structure_hash: str | None = None,
    ) -> None:
        # If a precomputed hash is provided, do not recompute (skips re-hashing the same Spec).
        resolved_spec_hash = spec_hash if spec_hash is not None else compute_spec_hash(spec)
        resolved_structure_hash = (
            structure_hash if structure_hash is not None else compute_structure_hash(spec)
        )
        # The composer emits at most one L2 sandbox node per Spec (kohaku.spec.validate's
        # validate_spec_structure warns with MULTIPLE_SANDBOX_NODES if that invariant is ever broken),
        # so picking the first is exhaustive.
        sandbox_node = next((c for c in spec.components if c.artifact is not None), None)
        artifact_id = (
            artifact_id_of(sandbox_node.artifact.sha256)
            if sandbox_node is not None and sandbox_node.artifact is not None
            else None
        )

        payload: dict[str, Any] = {
            "specHash": resolved_spec_hash,
            "structureHash": resolved_structure_hash,
            "intentHash": spec.intent.hash,
            "canonical": spec.intent.canonical,
            "params": spec.intent.params,
            "dataVersion": spec.dataVersion,
            "tier": spec.provenance.tier,
            "cache": spec.provenance.cache,
            "surface": surface,
        }
        if session_id is not None:
            payload["sessionId"] = session_id
        if spec.provenance.model is not None:
            payload["model"] = spec.provenance.model
        payload["durationMs"] = trace.durationMs
        if artifact_id is not None:
            payload["artifactId"] = artifact_id

        await self.record(
            "view.composed",
            payload,
            LineageActor(
                kind="system" if spec.provenance.tier == "L0" else "model",
                model=spec.provenance.model,
            ),
            tenant,
        )

        # Component Lineage for L2 parts: auto-record the first generation and use (the input source for promotion)
        if sandbox_node is not None and sandbox_node.artifact is not None and artifact_id is not None:
            # Record component.generated on first sighting per tenant. The Spec cache is tenant-neutral,
            # so tenants after the first may receive the same Spec as cache:hit. Regardless of cache, "record if not
            # yet recorded for this tenant" (the artifact inline is on the spec, so even cache:hit has recording material).
            known_key = f"{tenant or ''}\x00{artifact_id}"
            # So that concurrent composes interleaving at the "existence-check -> record" await boundary do not
            # double-record, reserve into the known set **before** the existence check. If the check/record fails,
            # roll back the reservation (prevent permanently fixing a missed record).
            if known_key not in self._known_generated_ids:
                self._known_generated_ids.add(known_key)
                try:
                    existing = await self._storage.list_lineage(
                        LineageFilter(
                            type=["component.generated"],
                            artifactId=artifact_id,
                            limit=1,
                            tenant=tenant,
                        )
                    )
                    if len(existing) == 0:
                        generated_payload: dict[str, Any] = {
                            "artifactId": artifact_id,
                            "artifactSha256": sandbox_node.artifact.sha256,
                            "intentHash": spec.intent.hash,
                            "canonical": spec.intent.canonical,
                            "specHash": resolved_spec_hash,
                        }
                        # Keep the artifact body too, since promotion review (preview / publish) needs it.
                        if sandbox_node.artifact.inline is not None:
                            generated_payload["html"] = sandbox_node.artifact.inline
                        # The data reference at generation time. Used to re-mount the preview with the same data.
                        if sandbox_node.data is not None and sandbox_node.data.ref is not None:
                            generated_payload["ref"] = sandbox_node.data.ref
                        if spec.provenance.model is not None:
                            generated_payload["model"] = spec.provenance.model
                        request = spec.intent.params.get("request")
                        if isinstance(request, str):
                            generated_payload["request"] = request
                        await self.record(
                            "component.generated",
                            generated_payload,
                            LineageActor(kind="model", model=spec.provenance.model),
                            tenant,
                        )
                except Exception:
                    self._known_generated_ids.discard(known_key)
                    raise
            used_payload: dict[str, Any] = {
                "artifactId": artifact_id,
                "intentHash": spec.intent.hash,
                "surface": surface,
                "outcome": "ok",
            }
            if session_id is not None:
                used_payload["sessionId"] = session_id
            await self.record("component.used", used_payload, None, tenant)

    async def view_rendered(
        self,
        *,
        spec_hash: str,
        surface: Surface,
        renderer: str,
        duration_ms: float | None = None,
        tenant: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {"specHash": spec_hash, "surface": surface, "renderer": renderer}
        if duration_ms is not None:
            payload["durationMs"] = duration_ms
        await self.record("view.rendered", payload, None, tenant)

    async def view_interacted(
        self,
        *,
        intent_hash: str,
        component_id: str,
        on: str,
        payload: JsonObject,
        surface: Surface,
        session_id: str | None = None,
        tenant: str | None = None,
    ) -> None:
        record_payload: dict[str, Any] = {
            "intentHash": intent_hash,
            "componentId": component_id,
            "on": on,
            "payload": payload,
            "surface": surface,
        }
        if session_id is not None:
            record_payload["sessionId"] = session_id
        await self.record("view.interacted", record_payload, LineageActor(kind="user"), tenant)

    async def view_fallback(
        self,
        *,
        spec_hash: str,
        reason: str,
        surface: Surface,
        kind: str | None = None,
        intent_hash: str | None = None,
        session_id: str | None = None,
        tenant: str | None = None,
    ) -> None:
        # Unspecified optionals (kind / intentHash / sessionId) are not stamped into the payload.
        # tenant is stamped into the record's tenant field, not the payload.
        payload: dict[str, Any] = {"specHash": spec_hash, "reason": reason, "surface": surface}
        if kind is not None:
            payload["kind"] = kind
        if intent_hash is not None:
            payload["intentHash"] = intent_hash
        if session_id is not None:
            payload["sessionId"] = session_id
        await self.record("view.fallback", payload, None, tenant)

    async def component_used(
        self,
        *,
        artifact_id: str,
        surface: Surface,
        outcome: str = "ok",
        session_id: str | None = None,
        intent_hash: str | None = None,
        source: str | None = None,
        tenant: str | None = None,
    ) -> None:
        payload: dict[str, Any] = {"artifactId": artifact_id, "surface": surface, "outcome": outcome}
        if session_id is not None:
            payload["sessionId"] = session_id
        if intent_hash is not None:
            payload["intentHash"] = intent_hash
        if source is not None:
            payload["source"] = source
        await self.record("component.used", payload, None, tenant)

    async def explain_view(self, spec_hash: str) -> list[LineageEventRecord]:
        """The audit query for "why this screen was displayed"."""
        return await self._storage.list_lineage(LineageFilter(specHash=spec_hash))

    async def history(self, artifact_id: str) -> list[LineageEventRecord]:
        """A part's provenance (generation -> use -> promotion)."""
        return await self._storage.list_lineage(
            LineageFilter(artifactId=artifact_id, type=list(COMPONENT_EVENT_TYPES))
        )

    async def list_events(
        self, filter: LineageFilter | None = None
    ) -> list[LineageEventRecord]:
        # Corresponds to TS's Lineage.list. Renamed to list_events to avoid clashing with the Python built-in
        # `list` (under mypy strict, a `list[...]` annotation would be misread as the method) (an intentional difference).
        return await self._storage.list_lineage(filter)


def create_lineage(
    storage: StoragePort,
    *,
    new_id: Callable[[], str] | None = None,
    clock: Clock | None = None,
) -> Lineage:
    return Lineage(
        storage,
        new_id=new_id if new_id is not None else _default_id,
        clock=clock if clock is not None else now_iso,
    )

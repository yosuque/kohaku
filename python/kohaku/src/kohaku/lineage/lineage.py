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
from collections.abc import Callable, Sequence
from typing import Any, Literal, Protocol

from kohaku.spec import (
    CacheKeyParts,
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

from .events import (
    COMPONENT_EVENT_TYPES,
    ActionApprovalRequestedPayload,
    ActionApprovedPayload,
    ActionDeniedPayload,
    ActionInvokedPayload,
    Clock,
    PolicyAppliedPayload,
    ViewComposedDecision,
    ViewDecisionAttempt,
    ViewDecisionDowngrade,
    make_event,
    now_iso,
)


class _AttemptLike(Protocol):
    """Structural subset of kohaku.composer's ComposeAttempt (lineage does not depend on composer)."""

    @property
    def kind(self) -> Literal["l1", "l2"]: ...
    @property
    def ok(self) -> bool: ...
    @property
    def issues(self) -> list[str] | None: ...
    @property
    def errorCode(self) -> Literal["CONFIG", "INVALID_OUTPUT", "PROVIDER", "ABORTED", "UNKNOWN"] | None: ...


class _DowngradeLike(Protocol):
    """Structural subset of kohaku.registry's Downgrade (lineage does not depend on registry). `from_` mirrors
    that dataclass's own field name (a trailing underscore since `from` is a Python keyword)."""

    @property
    def id(self) -> str: ...
    @property
    def from_(self) -> str: ...
    @property
    def to(self) -> str: ...
    @property
    def reason(self) -> str: ...


class _UsageLike(Protocol):
    @property
    def inputTokens(self) -> int: ...
    @property
    def outputTokens(self) -> int: ...


class ComposeTraceLike(Protocol):
    """The compose trace passed to view_composed.

    TS's ComposeTraceLike declares intent / dataVersion / cache / tier / model / durationMs, but at runtime
    view_composed references only durationMs (tier / cache / model etc. are taken from spec.provenance). This
    port requires only durationMs and leaves the rest to structural matching (composer.ComposeTrace satisfies it).
    Declared as a read-only property so a frozen dataclass (a test's FakeTrace, etc.) can also satisfy it.

    correlationId / cacheKey / cacheKeyParts / attempts / downgrades / coalesced / usage are all optional
    additions (U2) read by view_composed's explain-facing payload fields -- see its doc comment on each
    corresponding TypedDict key in events.py. A trace that lacks them (or returns None) gets the exact same
    view.composed / component.generated / component.used payload shape as before they existed.
    """

    @property
    def durationMs(self) -> float: ...
    @property
    def correlationId(self) -> str | None: ...
    @property
    def cacheKey(self) -> str | None: ...
    @property
    def cacheKeyParts(self) -> CacheKeyParts | None: ...
    @property
    def attempts(self) -> Sequence[_AttemptLike] | None: ...
    @property
    def downgrades(self) -> Sequence[_DowngradeLike] | None: ...
    @property
    def coalesced(self) -> bool | None: ...
    @property
    def usage(self) -> _UsageLike | None: ...


_MAX_DECISION_ISSUES = 5
_MAX_DECISION_ISSUE_LENGTH = 200


def truncate_issues(issues: list[str] | None) -> list[str] | None:
    """Caps an attempt's issues to at most _MAX_DECISION_ISSUES entries of at most
    _MAX_DECISION_ISSUE_LENGTH characters each (an ellipsis marks a truncated string), so a verbose
    validation-error trail cannot bloat the lineage record without bound. Returns None for an empty/unset
    list (keeps `issues` off the payload rather than recording `issues: []`)."""
    if not issues:
        return None
    capped = issues[:_MAX_DECISION_ISSUES]
    return [
        f"{issue[:_MAX_DECISION_ISSUE_LENGTH]}…" if len(issue) > _MAX_DECISION_ISSUE_LENGTH else issue
        for issue in capped
    ]


def cache_key_parts_to_wire(parts: CacheKeyParts) -> dict[str, Any]:
    """CacheKeyParts as a plain JSON-safe dict, omitting unset optional fields (mirrors TS's cacheKeyParts,
    which JSON.stringify drops `undefined` fields from automatically)."""
    out: dict[str, Any] = {"intentHash": parts.intentHash, "dataVersion": parts.dataVersion}
    if parts.catalogFingerprint is not None:
        out["catalogFingerprint"] = parts.catalogFingerprint
    if parts.specVersion is not None:
        out["specVersion"] = parts.specVersion
    if parts.generatorVersion is not None:
        out["generatorVersion"] = parts.generatorVersion
    if parts.policyFingerprint is not None:
        out["policyFingerprint"] = parts.policyFingerprint
    return out


_THROWN_ATTEMPT_MESSAGE: dict[str, str] = {
    "CONFIG": "The LLM provider was misconfigured.",
    "INVALID_OUTPUT": "The LLM's output could not be parsed.",
    "PROVIDER": "The LLM provider call failed.",
    "ABORTED": "Generation was aborted.",
    "UNKNOWN": "An unexpected error occurred during generation.",
}
"""The fixed, non-sensitive message persisted for a thrown-exception attempt, keyed by its errorCode (see
ViewDecisionAttempt's doc comment). Deliberately generic and static -- never derived from the exception
itself -- because a provider/network error's own message can carry a hostname, URL, or account details a
lineage.read principal (via /lineage, kohaku explain, or DevTools) has no business seeing."""


def build_decision(trace: ComposeTraceLike) -> ViewComposedDecision | None:
    """Builds view.composed's `decision` summary from the trace, or None when there is nothing to summarize
    (no attempts, no downgrades, not coalesced, no usage) -- the common case for a cache hit / L0 fixed Spec,
    which should not grow a `decision` key at all."""
    attempts = trace.attempts or []
    downgrades = trace.downgrades or []
    if len(attempts) == 0 and len(downgrades) == 0 and trace.coalesced is not True and trace.usage is None:
        return None
    decision_attempts: list[ViewDecisionAttempt] = []
    for a in attempts:
        entry: ViewDecisionAttempt = {"kind": a.kind, "ok": a.ok}
        # A thrown-exception attempt (errorCode set) never has its own issues (the exception's raw message,
        # needed only for the repair loop's in-process feedback/visibility) persisted here -- only the
        # fixed, non-sensitive message for its errorCode. A validation-failed attempt (errorCode unset)
        # keeps its actual issue strings, still truncated.
        if a.errorCode is not None:
            entry["issues"] = [_THROWN_ATTEMPT_MESSAGE[a.errorCode]]
            entry["errorCode"] = a.errorCode
        else:
            issues = truncate_issues(a.issues)
            if issues is not None:
                entry["issues"] = issues
        decision_attempts.append(entry)
    decision: ViewComposedDecision = {"attempts": decision_attempts}
    if len(downgrades) > 0:
        decision["downgrades"] = [
            ViewDecisionDowngrade(id=d.id, from_=d.from_, to=d.to, reason=d.reason) for d in downgrades
        ]
    if trace.coalesced is True:
        decision["coalesced"] = True
    if trace.usage is not None:
        decision["usage"] = {"inputTokens": trace.usage.inputTokens, "outputTokens": trace.usage.outputTokens}
    return decision


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
        if trace.correlationId is not None:
            payload["correlationId"] = trace.correlationId
        if trace.cacheKey is not None:
            payload["cacheKey"] = trace.cacheKey
        if trace.cacheKeyParts is not None:
            payload["cacheKeyParts"] = cache_key_parts_to_wire(trace.cacheKeyParts)
        if spec.provenance.generatorVersion is not None:
            payload["generatorVersion"] = spec.provenance.generatorVersion
        if spec.provenance.kit is not None:
            payload["kit"] = spec.provenance.kit.to_wire()
        if spec.provenance.fallback is not None:
            payload["fallback"] = spec.provenance.fallback.to_wire()
        decision = build_decision(trace)
        if decision is not None:
            payload["decision"] = decision

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
                        if trace.correlationId is not None:
                            generated_payload["correlationId"] = trace.correlationId
                        if spec.provenance.kit is not None:
                            generated_payload["kit"] = spec.provenance.kit.to_wire()
                        if spec.provenance.generatorVersion is not None:
                            generated_payload["generatorVersion"] = spec.provenance.generatorVersion
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
            if trace.correlationId is not None:
                used_payload["correlationId"] = trace.correlationId
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
        correlation_id: str | None = None,
    ) -> None:
        # Unspecified optionals (kind / intentHash / sessionId / correlationId) are not stamped into the
        # payload. tenant is stamped into the record's tenant field, not the payload.
        payload: dict[str, Any] = {"specHash": spec_hash, "reason": reason, "surface": surface}
        if kind is not None:
            payload["kind"] = kind
        if intent_hash is not None:
            payload["intentHash"] = intent_hash
        if session_id is not None:
            payload["sessionId"] = session_id
        if correlation_id is not None:
            payload["correlationId"] = correlation_id
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

    async def policy_applied(
        self,
        event: PolicyAppliedPayload,
        actor: LineageActor | None = None,
        tenant: str | None = None,
    ) -> None:
        """Records a policy.applied audit event (design.md #69). The caller (host_core's
        PolicyRuntime's audit callback) is responsible for the dedup rule ("a byte-identical reload is
        not audit-worthy") -- this method unconditionally records whatever it is given."""
        payload: dict[str, Any] = {
            "policyId": event["policyId"],
            "version": event["version"],
            "changedPaths": event["changedPaths"],
            "tenants": event["tenants"],
        }
        if event.get("previousPolicyId") is not None:
            payload["previousPolicyId"] = event["previousPolicyId"]
        if event.get("label") is not None:
            payload["label"] = event["label"]
        await self.record("policy.applied", payload, actor, tenant)

    async def action_invoked(
        self,
        event: ActionInvokedPayload,
        actor: LineageActor | None = None,
        tenant: str | None = None,
    ) -> None:
        """Records action.invoked (design.md #62/#63) -- the ActionGate returned "allow"."""
        payload: dict[str, Any] = {
            "action": event["action"],
            "payloadHash": event["payloadHash"],
            "tier": event["tier"],
        }
        if event.get("correlationId") is not None:
            payload["correlationId"] = event["correlationId"]
        await self.record("action.invoked", payload, actor, tenant)

    async def action_denied(
        self,
        event: ActionDeniedPayload,
        actor: LineageActor | None = None,
        tenant: str | None = None,
    ) -> None:
        """Records action.denied (design.md #63) -- a presented approval token did not verify."""
        payload: dict[str, Any] = {
            "action": event["action"],
            "payloadHash": event["payloadHash"],
            "tier": event["tier"],
            "reason": event["reason"],
        }
        if event.get("correlationId") is not None:
            payload["correlationId"] = event["correlationId"]
        await self.record("action.denied", payload, actor, tenant)

    async def action_approval_requested(
        self,
        event: ActionApprovalRequestedPayload,
        actor: LineageActor | None = None,
        tenant: str | None = None,
    ) -> None:
        """Records action.approvalRequested (design.md #63) -- nothing was presented yet. The caller
        (create_action_audit_recorder) is responsible for whether event["payload"] is populated (its own
        record_payload option); this method records unconditionally whatever it is given."""
        payload: dict[str, Any] = {
            "action": event["action"],
            "payloadHash": event["payloadHash"],
            "tier": event["tier"],
            "requestId": event["requestId"],
        }
        if event.get("payload") is not None:
            payload["payload"] = event["payload"]
        if event.get("correlationId") is not None:
            payload["correlationId"] = event["correlationId"]
        await self.record("action.approvalRequested", payload, actor, tenant)

    async def action_approved(
        self,
        event: ActionApprovedPayload,
        actor: LineageActor | None = None,
        tenant: str | None = None,
    ) -> None:
        """Records action.approved (design.md #63) -- a presented approval grant was successfully consumed."""
        payload: dict[str, Any] = {
            "action": event["action"],
            "payloadHash": event["payloadHash"],
            "approverId": event["approverId"],
            "requesterId": event["requesterId"],
        }
        if event.get("correlationId") is not None:
            payload["correlationId"] = event["correlationId"]
        await self.record("action.approved", payload, actor, tenant)

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

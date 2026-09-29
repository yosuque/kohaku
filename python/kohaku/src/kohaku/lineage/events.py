"""Lineage event type catalog (Port of TS packages/lineage/src/events.ts).

Two lines: View Lineage (why this screen appeared = Event Sourcing of the UI Spec) and
Component Lineage (a part's generation / review / promotion provenance).

Differences from TS:
- Time generation (new Date().toISOString()) is made injectable via make_event's clock argument
  (for test determinism; the default is now_iso = real time).
- Because LineageEventRecord is a dataclass, it always has a tenant field (default None). The wire
  form (storage._lineage_to_wire) omits tenant when it is None, so TS's intent of "do not change the
  persistence format for single-tenant users" is preserved.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal, TypedDict

from kohaku.spec import LineageActor, LineageEventRecord

# Rejection has no dedicated event (component.rejected): a rejection is recorded as a review.reject
# transition in component.reviewed (decision:"reject", reviewer) (see act in service.py).
VIEW_EVENT_TYPES: tuple[str, ...] = (
    "view.composed",
    "view.rendered",
    "view.interacted",
    "view.fallback",
)

COMPONENT_EVENT_TYPES: tuple[str, ...] = (
    "component.generated",
    "component.used",
    "component.nominated",
    "component.judged",
    "component.reviewed",
    "component.schemaProposed",
    "component.published",
    "component.withdrawn",
)

# intent.fixated / intent.unfixated / intent.migrated are fired by the fixations service. intent.observed
# is a **deliberately reserved type** not fired in v0.1 (docs/specification.md §10 "reservation in the type
# catalog"). intent.migrated (design.md #65) is fired by Fixations.replace when a catalog migration
# rewrites a fixated Spec's components in place.
FIXATION_EVENT_TYPES: tuple[str, ...] = (
    "intent.observed",
    "intent.fixated",
    "intent.unfixated",
    "intent.migrated",
)

# Policy as Code's audit trail (design.md #69). Fired by host_core's PolicyRuntime.reload() only when
# the effective policy_id actually changes (the dedup rule -- "a byte-identical reload is not
# audit-worthy" -- lives in host_core, not here).
POLICY_EVENT_TYPES: tuple[str, ...] = ("policy.applied",)

# Governed Actions' audit trail (design.md #62/#63). Fired by create_action_audit_recorder's adapter
# (recorder.py), driven by host_core's ActionGate outcome for every invoke attempt:
# - action.invoked -- the gate returned "allow" (params validated, tier satisfied).
# - action.denied -- tier "approve" and a token *was* presented but did not verify (or no ApprovalPort
#   is configured at all).
# - action.approvalRequested -- nothing was presented yet ("confirm" without confirmed: true, or
#   "approve" without a token).
# - action.approved -- tier "approve" and the presented approval grant was successfully consumed
#   (recorded in addition to, not instead of, action.invoked).
ACTION_EVENT_TYPES: tuple[str, ...] = (
    "action.invoked",
    "action.denied",
    "action.approvalRequested",
    "action.approved",
)

LineageEventType = Literal[
    "view.composed",
    "view.rendered",
    "view.interacted",
    "view.fallback",
    "component.generated",
    "component.used",
    "component.nominated",
    "component.judged",
    "component.reviewed",
    "component.schemaProposed",
    "component.published",
    "component.withdrawn",
    "intent.observed",
    "intent.fixated",
    "intent.unfixated",
    "intent.migrated",
    "policy.applied",
    "action.invoked",
    "action.denied",
    "action.approvalRequested",
    "action.approved",
]
"""Closed vocabulary of Lineage event types."""

# Corresponds to TS's ActorKind = LineageEventRecord["actor"].
ActorKind = LineageActor

Clock = Callable[[], str]
"""A clock that returns a time string (ISO8601). Parameterized so tests can inject a fixed time."""


class ViewDecisionAttempt(TypedDict, total=False):
    """One L1/L2 generation attempt, as recorded on view.composed's `decision` summary (structural subset of
    kohaku.composer's ComposeAttempt -- lineage does not depend on composer, see ComposeTraceLike's doc)."""

    kind: Literal["l1", "l2"]
    ok: bool
    issues: list[str]
    """For a validation-failed attempt (schema/catalog issues describing the model's own structural output),
    the actual issue strings, capped to at most 5 entries of at most 200 characters each (see lineage.py's
    truncate_issues) so a verbose validation-error trail cannot bloat the lineage record without bound. For a
    thrown-exception attempt (errorCode set below), this instead holds exactly one fixed, non-sensitive
    message for that code -- never the exception's own message."""
    errorCode: Literal["CONFIG", "INVALID_OUTPUT", "PROVIDER", "ABORTED", "UNKNOWN"]
    """Set only when this attempt failed by a thrown exception (never by a schema/catalog validation
    rejection of a successfully-parsed draft) -- a closed, non-sensitive vocabulary (composer's own
    LlmErrorCode, or "UNKNOWN" for a non-LlmError throw). See lineage.py's build_decision: a
    provider/network error's own message can carry a hostname, URL, or account details a lineage.read
    principal (via /lineage, kohaku explain, or DevTools) has no business seeing, so it is never persisted
    here."""


class ViewDecisionDowngrade(TypedDict):
    """One capability-negotiation downgrade, as recorded on view.composed's `decision` summary (wire shape of
    kohaku.registry's Downgrade -- lineage does not depend on registry either)."""

    id: str
    from_: str
    to: str
    reason: str


class ViewDecisionUsage(TypedDict):
    inputTokens: int
    outputTokens: int


class ViewComposedDecision(TypedDict, total=False):
    """Summarizes "what compose actually did" for a devtool (`kohaku explain`, admin-react's DevTools) trying
    to answer "why did this view come out this way" -- the L1/L2 attempts (with their failure issues,
    capped), any capability-negotiation downgrades, whether this compose rode along on another one under
    single-flight, and the summed LLM token usage. Recorded only when there is something to summarize (see
    lineage.py's build_decision): a cache hit / L0 fixed Spec with no attempts, downgrades, coalescing, or
    usage leaves this key off the payload entirely, same as every other optional field here."""

    attempts: list[ViewDecisionAttempt]
    downgrades: list[ViewDecisionDowngrade]
    coalesced: bool
    usage: ViewDecisionUsage


class ViewComposedPayload(TypedDict, total=False):
    """The view.composed payload (required: specHash / intentHash / canonical / dataVersion /
    tier / cache / surface; optional: sessionId / model / durationMs / artifactId / the explain-facing
    fields below)."""

    specHash: str
    intentHash: str
    canonical: str
    dataVersion: str
    tier: Literal["L0", "L1", "L2"]
    cache: str
    surface: str
    sessionId: str
    model: str
    durationMs: float
    artifactId: str
    correlationId: str
    """The caller-supplied correlation id (the compose trace's correlationId), so a devtool can find every
    lineage event belonging to one request via the `/lineage?correlationId=` filter. Unset for a compose
    whose caller passed none, and always unset for an event recorded before this field existed."""
    cacheKey: str
    """The Spec cache key this compose resolved to (opaque; see cacheKeyParts for its breakdown)."""
    cacheKeyParts: dict[str, Any]
    """The individual components `cacheKey` was built from (kohaku.spec.CacheKeyParts, wire-shaped via
    lineage.py's cache_key_parts_to_wire)."""
    generatorVersion: str
    """The host's generator identity in effect at composition time (spec.provenance.generatorVersion)."""
    kit: dict[str, str]
    """The design kit the generated markup was written against (spec.provenance.kit.to_wire())."""
    fallback: dict[str, Any]
    """The demotion trace when this Spec is a deterministic/negotiation fallback (spec.provenance.fallback.to_wire())."""
    decision: ViewComposedDecision
    """A summary of the compose decision (attempts / downgrades / coalescing / token usage). See
    ViewComposedDecision's doc comment for when this key is present."""


class ComponentGeneratedPayload(TypedDict, total=False):
    """The component.generated payload (required: artifactId / artifactSha256 / intentHash /
    canonical / specHash; optional: model / request / html / ref / correlationId, kit, generatorVersion)."""

    artifactId: str
    artifactSha256: str
    intentHash: str
    canonical: str
    specHash: str
    model: str
    request: str
    html: str
    ref: str
    correlationId: str
    """The compose trace's correlation id (see ViewComposedPayload.correlationId's doc comment)."""
    kit: dict[str, str]
    """The design kit the generated markup was written against (spec.provenance.kit.to_wire()). Read by the
    promotion review UI (admin-react Promotions) to show which kit a candidate component was generated against."""
    generatorVersion: str
    """The host's generator identity in effect at generation time (spec.provenance.generatorVersion). Read
    by the promotion review UI alongside `kit` above."""


class ComponentUsedPayload(TypedDict, total=False):
    """The component.used payload. source is the recording path: "compose" (server-authoritative, the
    source of truth for promotion aggregation) / "telemetry" (observed real render; excluded from the
    promotion-aggregation uses). Unset = aggregated as equivalent to compose."""

    artifactId: str
    intentHash: str
    surface: str
    sessionId: str
    outcome: Literal["ok", "error"]
    source: Literal["compose", "telemetry"]
    correlationId: str
    """The compose trace's correlation id (see ViewComposedPayload.correlationId's doc comment). Only ever
    set on the compose-time recording inside view_composed -- a later component_used telemetry call has no
    compose trace to read a correlation id from."""


class PolicyAppliedPayload(TypedDict, total=False):
    """The policy.applied payload (required: policyId / version / changedPaths / tenants; optional:
    previousPolicyId / label). Structurally identical to host_core's PolicyAppliedEvent
    (kohaku/host_core/policy.py) -- duplicated here rather than imported, the same convention every
    other payload type in this file follows (ViewComposedPayload / ComponentGeneratedPayload etc. are
    never imported from the package that produces them): a LineageEventRecord.payload shape is a
    wire/audit concern owned by this module, independent of whichever caller happens to produce
    matching data today."""

    policyId: str
    previousPolicyId: str
    version: int
    label: str
    changedPaths: list[str]
    tenants: list[str]


class ActionInvokedPayload(TypedDict, total=False):
    """The action.invoked payload (design.md #62/#63). Only payloadHash is recorded, never the invoke
    payload itself -- the audit trail proves *that* a specific payload (by hash) was invoked and under
    which tier, without persisting whatever business data the payload carried."""

    action: str
    payloadHash: str
    tier: Literal["auto", "confirm", "approve"]
    correlationId: str


class ActionDeniedPayload(TypedDict, total=False):
    """The action.denied payload (design.md #62/#63): either an "approve"-tier invoke whose presented
    token did not verify (or no ApprovalPort was configured at all; tier is "confirm" or "approve"), or an
    invoke whose action name is not one of the DomainPort's own declared operations, rejected before any
    governed-action gate ever ran (tier is "auto")."""

    action: str
    payloadHash: str
    tier: Literal["auto", "confirm", "approve"]
    reason: str
    correlationId: str


class ActionApprovalRequestedPayload(TypedDict, total=False):
    """The action.approvalRequested payload (design.md #63): nothing was presented yet for a "confirm" or
    "approve"-tier invoke. `payload` (the raw invoke payload, not just its hash) is included only when the
    recorder is configured with record_payload=True -- the default omits it, matching every other action.*
    event's "hash only" stance; an operator opts in when an approver-facing flow needs to see the actual
    content being approved (e.g. the note text of an annotate action) rather than just its hash."""

    action: str
    payloadHash: str
    tier: Literal["confirm", "approve"]
    requestId: str
    payload: dict[str, Any]
    correlationId: str


class ActionApprovedPayload(TypedDict, total=False):
    """The action.approved payload (design.md #63): an "approve"-tier invoke whose presented approval
    grant was successfully consumed. Recorded in addition to (not instead of) action.invoked."""

    action: str
    payloadHash: str
    approverId: str
    requesterId: str
    correlationId: str


_SYSTEM_ACTOR = LineageActor(kind="system")


def now_iso() -> str:
    """Equivalent to new Date().toISOString() (UTC, 3-digit milliseconds, trailing Z)."""
    dt = datetime.now(UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def make_event(
    id: str,
    type: str,
    payload: dict[str, Any],
    actor: LineageActor | None = None,
    tenant: str | None = None,
    *,
    clock: Clock = now_iso,
) -> LineageEventRecord:
    """Assemble a Lineage record. An unspecified actor is {kind:"system"}. tenant is stamped only when non-None."""
    return LineageEventRecord(
        id=id,
        ts=clock(),
        actor=actor if actor is not None else _SYSTEM_ACTOR,
        type=type,
        payload=payload,
        tenant=tenant,
    )

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

# intent.fixated / intent.unfixated are fired by the fixations service. intent.observed is a
# **deliberately reserved type** not fired in v0.1 (docs/specification.md §10 "reservation in the type catalog").
FIXATION_EVENT_TYPES: tuple[str, ...] = (
    "intent.observed",
    "intent.fixated",
    "intent.unfixated",
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
]
"""Closed vocabulary of Lineage event types."""

# Corresponds to TS's ActorKind = LineageEventRecord["actor"].
ActorKind = LineageActor

Clock = Callable[[], str]
"""A clock that returns a time string (ISO8601). Parameterized so tests can inject a fixed time."""


class ViewComposedPayload(TypedDict, total=False):
    """The view.composed payload (required: specHash / intentHash / canonical / dataVersion /
    tier / cache / surface; optional: sessionId / model / durationMs / artifactId)."""

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


class ComponentGeneratedPayload(TypedDict, total=False):
    """The component.generated payload (required: artifactId / artifactSha256 / intentHash /
    canonical / specHash; optional: model / request / html / ref)."""

    artifactId: str
    artifactSha256: str
    intentHash: str
    canonical: str
    specHash: str
    model: str
    request: str
    html: str
    ref: str


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

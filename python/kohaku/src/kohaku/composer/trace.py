"""Per-stage decision record of compose (port of TS trace.ts). Feeds lineage and evals."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from kohaku.spec import Intent, SemanticInput

if TYPE_CHECKING:
    from kohaku.registry import Downgrade


# Wire-contract fields (kept in sync with TS) are camelCase; internal-only fields are snake_case.
@dataclass(frozen=True)
class TokenUsage:
    inputTokens: int
    outputTokens: int


@dataclass(frozen=True)
class ComposeAttempt:
    kind: Literal["l1", "l2"]
    ok: bool
    issues: list[str] | None = None
    usage: TokenUsage | None = None


type TraceInput = SemanticInput | Literal["intent"]
"""Kind of input recorded on the trace. Structured Intent input drops its body and keeps only "intent"."""


@dataclass
class ComposeTrace:
    """Per-stage decision record of compose. Unlike the Spec body it is not cached, so it may
    carry wall-clock information.

    cache="fixated" denotes a fixation short-circuit (short-circuited on the host side). The composer
    core only sets hit/miss/bypass; the host uses this value downstream when it short-circuits via fixation.
    """

    input: TraceInput
    intent: Intent
    refs: list[str]
    dataVersion: str
    cacheKey: str
    cache: Literal["hit", "miss", "bypass", "fixated"]
    tier: Literal["L0", "L1", "L2"]
    attempts: list[ComposeAttempt]
    durationMs: float
    fallback_reason: str | None = None
    downgrades: list[Downgrade] = field(default_factory=list)
    model: str | None = None
    coalesced: bool = False
    """True when this compose rode along (coalesced) on a preceding compose's result under single-flight. attempts is empty."""
    usage: TokenUsage | None = None
    """Sum of the attempts' usage (set only when at least one attempt carries usage)."""
    cancelled: bool = False
    """True when the delivered fallback Spec was caused by the caller's AbortSignal firing (a client
    disconnect or timeout), not an actual generation failure. Hosts check this to skip recording
    view.composed/view.fallback for the compose (a cancel must not inflate the fallback-rate analytics
    the same way a real generation failure does). Never set on an "ok" tier result."""

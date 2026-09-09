"""Cost/token budget guard (port of TS budget.ts).

The verdict is made right before each LLM call (before L1 generation, before repair, before L2). On
rejection, all subsequent LLM calls are skipped and the request degrades to the deterministic fallback.
The budget is a "threshold that stops additional calls", not a cap on a single call (an LLM's output
size cannot be determined ahead of time).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from kohaku.llm import AbortSignal

from .trace import ComposeAttempt


@dataclass(frozen=True)
class BudgetVerdict:
    """Result of a budget verdict. When allow=False, reason holds the degradation reason (the value placed on fallback.reason)."""

    allow: bool
    reason: str | None = None


@dataclass(frozen=True)
class ComposeBudget:
    """Configuration of the cost/token/deadline budget guard.

    - per_compose_stop_after_tokens: cumulative token threshold at which additional LLM calls stop
      (once the accumulated attempt usage reaches this value, the rest is skipped; 0 means "never generate").
    - check: a product-supplied global budget hook. Must be a side-effect-free, idempotent read.
      A throw is swallowed and lets the request through (fail-open) — the firing is made observable via on_check_error.
    - deadline_ms: a wall-clock deadline for one whole compose/compose_stream call, in milliseconds elapsed
      since `PreparedCompose.started_at`. See `check_budget`'s `elapsed_ms` parameter and
      `create_deadline_guard` below. When unset, behavior and performance are completely unchanged (no timer
      is armed, no extra clock read is made, and the abort signal passed to LLM calls is `ComposeOptions.abort`
      verbatim).
    """

    per_compose_stop_after_tokens: int | None = None
    check: Callable[[], BudgetVerdict] | None = None
    deadline_ms: float | None = None


def check_budget(
    budget: ComposeBudget | None,
    spent: int,
    on_check_error: Callable[[BaseException], None] | None = None,
    elapsed_ms: float | None = None,
) -> BudgetVerdict:
    """Decides whether we may make one more LLM call. Always allows when budget is unset.

    per_compose is checked first, then deadline_ms, then check() (each earlier check short-circuits the
    later ones). Even when several are involved, the first one to reject wins and is placed on reason —
    per_compose's token-threshold reason takes precedence over a simultaneous deadline overage.

    elapsed_ms (wall-clock milliseconds since the compose started — the caller supplies it; this function
    never reads the clock itself, keeping it a pure/deterministic function of its arguments) is checked
    against budget.deadline_ms only when BOTH are given. A caller that never measures elapsed time (passes
    no elapsed_ms) sees no deadline check performed, matching budget.deadline_ms's own "unset ⇒ unchanged"
    contract from the other direction.
    """
    if budget is None:
        return BudgetVerdict(allow=True)
    max_tokens = budget.per_compose_stop_after_tokens
    if max_tokens is not None and spent >= max_tokens:
        return BudgetVerdict(
            allow=False, reason=f"Budget exceeded: token threshold {max_tokens} reached (spent {spent})"
        )
    deadline_ms = budget.deadline_ms
    if deadline_ms is not None and elapsed_ms is not None and elapsed_ms >= deadline_ms:
        return BudgetVerdict(
            allow=False,
            reason=f"Budget exceeded: deadline {deadline_ms}ms reached (elapsed {elapsed_ms}ms)",
        )
    if budget.check is not None:
        try:
            verdict = budget.check()
        except Exception as e:  # noqa: BLE001 — a throw in the budget hook must not break compose
            # An undecidable verdict lets the request through (generation continues). Mirror the firing to the observer hook (never a silent fail-open).
            if on_check_error is not None:
                on_check_error(e)
            return BudgetVerdict(allow=True)
        if not verdict.allow:
            return BudgetVerdict(
                allow=False,
                reason=verdict.reason
                if verdict.reason is not None
                else "Budget exceeded: generation skipped by budget hook",
            )
    return BudgetVerdict(allow=True)


def sum_spent_tokens(attempts: list[ComposeAttempt]) -> int:
    """Sum of the attempts' usage (input+output). An attempt without usage counts as 0."""
    total = 0
    for a in attempts:
        if a.usage is None:
            continue
        total += a.usage.inputTokens + a.usage.outputTokens
    return total


@dataclass(frozen=True)
class DeadlineGuard:
    """The abort signal + disposer produced by create_deadline_guard for one compose-wide deadline. `signal`
    is what generate_l1/generate_l2 must pass to the LLM call in place of the caller's own abort signal;
    `deadline_signal` is a second, narrower signal used only to tell "the deadline fired" apart from "the
    caller's own AbortSignal (or the per-call KOHAKU_LLM_TIMEOUT_MS floor) fired" at the classification site
    in l1_generate.py/l2_generate.py.
    """

    signal: AbortSignal | None
    """The signal to pass to LLM calls: the caller's own abort signal combined (via AbortSignal.any) with a
    timer that fires once budget.deadline_ms elapses. Identical to `caller_signal` — the same reference, not
    merely equivalent — whenever `budget.deadline_ms` is unset, so a caller that never sets it is
    byte-identical to before this guard existed."""
    deadline_signal: AbortSignal | None
    """Fires only when the compose-wide deadline elapses (never by caller_signal aborting on its own).
    None whenever `budget.deadline_ms` is unset. Checking `deadline_signal.aborted` after catching an
    ABORTED LlmError is how the deadline is told apart from a genuine client cancellation."""
    dispose: Callable[[], None]
    """Clears the underlying timer. Must be called once generation settles (success or fallback), in a
    `finally`, so a deadline that never fires does not leave a dangling timer. A no-op when no timer was armed."""


def create_deadline_guard(
    budget: ComposeBudget | None,
    started_at: float,
    caller_signal: AbortSignal | None,
    now: Callable[[], float] | None = None,
) -> DeadlineGuard:
    """Arms the compose-wide deadline (`ComposeBudget.deadline_ms`), once per compose, shared across the
    whole L1→L2 ladder (the initial L1 call, every repair re-attempt, and L2) rather than reset per attempt
    — so it bounds the wall-clock time of the *compose*, not any single LLM call. Called from compose.py's
    `_run_tier_generation`; disposed in that same function's `finally` once the ladder settles.

    Between-call enforcement (check_budget's `elapsed_ms` check, run immediately before each LLM call)
    already stops the ladder from *starting* another call once the deadline has passed. This guard
    additionally covers the case where a call is already in flight when the deadline elapses mid-call: the
    timer aborts `signal`, which is threaded into the LLM call as `req.abort` exactly like `caller_signal`
    was before, so the call rejects with an `LlmError` (code `ABORTED`) the same way a caller cancellation
    does. What differs is classification: `deadline_signal` — armed by nothing else — lets the caller (the
    repair loop in l1_generate.py/l2_generate.py) tell that this particular `ABORTED` came from the deadline
    (and must be treated as a budget-guard fallback, counted in the generation-fallback rate) rather than
    from the caller's own signal (a client disconnect, excluded from that rate — see docs/design.md §5).

    `started_at`/`now` are in the same unit `PreparedCompose.started_at` already uses (`time.monotonic()`
    seconds, not `Date.now()` milliseconds like TS) — only `budget.deadline_ms` itself stays in milliseconds,
    matching the field's name and TS's wire-adjacent meaning. `now` is injectable for tests (default
    `time.monotonic`, resolved at call time rather than bound as a default value so a test can monkeypatch
    `time.monotonic` itself); pass a fixed value to construct a guard with a predetermined remaining duration
    without depending on wall-clock time at test-run time.
    """
    deadline_ms = budget.deadline_ms if budget is not None else None
    if deadline_ms is None:
        return DeadlineGuard(signal=caller_signal, deadline_signal=None, dispose=lambda: None)
    clock = now if now is not None else time.monotonic
    elapsed_ms = (clock() - started_at) * 1000
    remaining_ms = max(0.0, deadline_ms - elapsed_ms)
    deadline_signal = AbortSignal.timeout(remaining_ms)
    signal = (
        AbortSignal.any([caller_signal, deadline_signal]) if caller_signal is not None else deadline_signal
    )
    return DeadlineGuard(signal=signal, deadline_signal=deadline_signal, dispose=deadline_signal.cancel_timer)

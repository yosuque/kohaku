"""Cost/token budget guard (port of TS budget.ts).

The verdict is made right before each LLM call (before L1 generation, before repair, before L2). On
rejection, all subsequent LLM calls are skipped and the request degrades to the deterministic fallback.
The budget is a "threshold that stops additional calls", not a cap on a single call (an LLM's output
size cannot be determined ahead of time).
"""

from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from kohaku.llm import AbortSignal

from .trace import ComposeAttempt, TokenUsage


@dataclass(frozen=True)
class BudgetVerdict:
    """Result of a budget verdict. When allow=False, reason holds the degradation reason (the value placed on fallback.reason)."""

    allow: bool
    reason: str | None = None


@dataclass(frozen=True)
class BudgetCheckContext:
    """Port of TS composer/context.ts's BudgetCheckContext. Passed to `ComposeBudget.check_with_context`
    so a host-supplied hook can make a tenant-/tier-aware decision. Also the shape `check_budget` uses
    internally for its own per_compose/deadline verdicts, so the object handed to the hook is the exact
    same data those checks already computed (no duplicated bookkeeping)."""

    tier: Literal["L1", "L2"]
    """The tier about to make an LLM call."""
    spent_tokens: int
    """The accumulated usage (inputTokens + outputTokens) of the attempts so far in this compose."""
    tenant: str | None = None
    """SessionContext.tenant, threaded through unchanged (PreparedCompose.tenant)."""
    elapsed_ms: float | None = None
    """Wall-clock milliseconds elapsed since the compose started. Only set when budget.deadline_ms is in play."""


@dataclass(frozen=True)
class ComposeBudget:
    """Configuration of the cost/token/deadline budget guard.

    - per_compose_stop_after_tokens: cumulative token threshold at which additional LLM calls stop
      (once the accumulated attempt usage reaches this value, the rest is skipped; 0 means "never generate").
    - check: a product-supplied global budget hook taking no arguments. Must be a side-effect-free,
      idempotent read. A throw is swallowed and lets the request through (fail-open) — the firing is made
      observable via on_check_error.
    - check_with_context: like `check`, but receives a `BudgetCheckContext` (tenant/tier/spent_tokens/
      elapsed_ms). A **separate field** rather than widening `check`'s own signature: unlike TS (where a
      `() => ...` function value is structurally assignable to a wider `(ctx?) => ...` parameter type,
      so one field could grow an optional argument backward-compatibly), Python has no such "fewer
      parameters is a subtype" rule, and detecting the hook's arity via `inspect.signature` would be
      fragile (bound methods, functools.partial, decorated callables, etc.) — so this stays a second,
      independent field instead. When both are set, `check_with_context` wins (see `check_budget`); a
      caller migrating an existing `check` need not remove it in the same change.
    - deadline_ms: a wall-clock deadline for one whole compose/compose_stream call, in milliseconds elapsed
      since `PreparedCompose.started_at`. See `check_budget`'s `ctx.elapsed_ms` and
      `create_deadline_guard` below. When unset, behavior and performance are completely unchanged (no timer
      is armed, no extra clock read is made, and the abort signal passed to LLM calls is `ComposeOptions.abort`
      verbatim).
    - on_usage: fired after an LLM call that actually happened (never for a cache hit or the L0 fixed-Spec
      short-circuit, neither of which reach the budget guard at all), with `(tenant, usage)` — the
      compose's total usage (the same aggregation as `ComposeTrace.usage`). Unlike `check`/
      `check_with_context` (a read consulted *before* every call, potentially several times per compose),
      this fires **exactly once per compose that actually generated**, after generation has settled — the
      natural point for a host to debit a persisted daily/tenant budget ledger that `check`/
      `check_with_context` later reads back. Side effects belong here, not in the check hooks. A throw /
      awaited rejection is swallowed (fail-open, see `notify_budget_usage`) so a broken ledger write can
      never turn an already-delivered Spec into a hard failure. Purely additive: when unset, behavior is
      completely unchanged.
    """

    per_compose_stop_after_tokens: int | None = None
    check: Callable[[], BudgetVerdict] | None = None
    check_with_context: Callable[[BudgetCheckContext], BudgetVerdict] | None = None
    deadline_ms: float | None = None
    on_usage: Callable[[str | None, TokenUsage], None] | None = None


def _evaluate_check(
    invoke: Callable[[], BudgetVerdict],
    on_check_error: Callable[[BaseException], None] | None,
) -> BudgetVerdict:
    """Shared try/except + reason-defaulting body for both `check` and `check_with_context`."""
    try:
        verdict = invoke()
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


def check_budget(
    budget: ComposeBudget | None,
    ctx: BudgetCheckContext,
    on_check_error: Callable[[BaseException], None] | None = None,
) -> BudgetVerdict:
    """Decides whether we may make one more LLM call. Always allows when budget is unset.

    per_compose is checked first, then deadline_ms, then check_with_context()/check() (each earlier check
    short-circuits the later ones). Even when several are involved, the first one to reject wins and is
    placed on reason — per_compose's token-threshold reason takes precedence over a simultaneous deadline
    overage.

    `ctx` doubles as the object passed verbatim to `budget.check_with_context(ctx)` — the same
    `tier`/`spent_tokens`/`elapsed_ms` this function already computed its own per_compose/deadline
    verdicts from, plus `ctx.tenant` (unused by this function itself, threaded through only for the hook).
    `ctx.elapsed_ms` is checked against `budget.deadline_ms` only when BOTH are given: a caller that never
    measures elapsed time (leaves `elapsed_ms` unset) sees no deadline check performed, matching
    `budget.deadline_ms`'s own "unset ⇒ unchanged" contract from the other direction.
    """
    if budget is None:
        return BudgetVerdict(allow=True)
    max_tokens = budget.per_compose_stop_after_tokens
    if max_tokens is not None and ctx.spent_tokens >= max_tokens:
        return BudgetVerdict(
            allow=False,
            reason=f"Budget exceeded: token threshold {max_tokens} reached (spent {ctx.spent_tokens})",
        )
    deadline_ms = budget.deadline_ms
    if deadline_ms is not None and ctx.elapsed_ms is not None and ctx.elapsed_ms >= deadline_ms:
        return BudgetVerdict(
            allow=False,
            reason=f"Budget exceeded: deadline {deadline_ms}ms reached (elapsed {ctx.elapsed_ms}ms)",
        )
    check_with_context = budget.check_with_context
    if check_with_context is not None:
        return _evaluate_check(lambda: check_with_context(ctx), on_check_error)
    check = budget.check
    if check is not None:
        return _evaluate_check(check, on_check_error)
    return BudgetVerdict(allow=True)


def _fire_and_forget(invoke: Callable[[], Any]) -> None:
    """Local copy of compose.py's `_fire_and_forget` (duplicated rather than imported: compose.py already
    imports from this module, so importing back would cycle). Swallows a synchronous exception or an
    awaited rejection so a broken hook never surfaces to the caller."""
    try:
        result = invoke()
        if inspect.isawaitable(result):
            task = asyncio.ensure_future(result)
            task.add_done_callback(lambda t: t.exception())  # absorb rejects (prevent unobserved warnings)
    except Exception:  # noqa: BLE001,S110 — a broken hook must not break compose
        pass


def notify_budget_usage(
    budget: ComposeBudget | None,
    usage: TokenUsage | None,
    tenant: str | None = None,
) -> None:
    """Fail-open call of `ComposeBudget.on_usage`, made exactly once per compose that actually generated
    (`usage` is None whenever no attempt reported usage — a cache hit or the L0 fixed-Spec short-circuit
    never reach the caller of this function at all, and a fallback with zero LLM attempts has nothing to
    report either, so both are already excluded by this same check). A no-op (byte-identical to before
    `on_usage` existed) whenever `budget`/`budget.on_usage` is unset. Port of TS budget.ts's
    notifyBudgetUsage."""
    on_usage = budget.on_usage if budget is not None else None
    if on_usage is None or usage is None:
        return
    _fire_and_forget(lambda: on_usage(tenant, usage))


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

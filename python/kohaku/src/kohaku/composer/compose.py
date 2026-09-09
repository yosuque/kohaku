"""The single entry point of the UI Composition Service (port of TS compose.ts).

normalize → resolve_query → cache lookup → L0/L1/L2 → deterministic post-processing → cache store.
Cross-surface identical display is structurally guaranteed by the cache key (intentHash + dataVersion +
catalogFingerprint). temperature 0 is merely an aid to reduce jitter in the initial generation.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
import weakref
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, Literal

from kohaku.llm import AbortController, AbortSignal
from kohaku.registry import negotiate
from kohaku.spec import (
    SPEC_VERSION,
    CacheKeyParts,
    DataShape,
    GuiAction,
    Intent,
    IntentInput,
    NLQuery,
    QueryHandle,
    SessionContext,
    SpecPatch,
    UISpec,
    cache_key,
    combine_data_versions,
    diff_spec,
    finalize_intent,
    parse_spec,
)

from .budget import ComposeBudget, check_budget, create_deadline_guard, sum_spent_tokens
from .context import (
    BudgetCheckErrorContext,
    ComposeContext,
    ComposeErrorContext,
    ComposePolicy,
    OnDraftPartial,
    ResolvedRefs,
    policy_fingerprint,
    tier_llm_fingerprint_material,
)
from .errors import ComposeError
from .fallback import build_fallback_spec
from .l1_generate import generate_l1
from .l2_generate import generate_l2
from .post import PostProcessContext, post_process
from .trace import ComposeAttempt, ComposeTrace, TokenUsage, TraceInput

COMPOSER_ID = "composer@0.1.0"

type ComposeInput = NLQuery | GuiAction | IntentComposeInput


@dataclass(frozen=True)
class IntentComposeInput:
    """compose input with a structured Intent (equivalent to TS {kind:"intent", intent})."""

    intent: IntentInput
    kind: Literal["intent"] = "intent"


@dataclass(frozen=True)
class ComposeOptions:
    session: SessionContext | None = None
    abort: AbortSignal | None = None
    """The caller's abort signal. Threads through L1/L2 LLM generation (including the repair loop)."""
    policy_override: dict[str, Any] | None = None
    """A caller-supplied partial override applied on top of the resolved policy, after ctx.policy and,
    when wired, ctx.policyFor's session policy have both been resolved. Exists so that a caller-level
    policy decision (recompose's respect_prev_tier routing to L2, for instance) is never silently
    discarded by policyFor overwriting `policy` wholesale — see ComposeContext.with_policy_override,
    which applies this last."""


@dataclass(frozen=True)
class ComposeResult:
    spec: UISpec
    trace: ComposeTrace


@dataclass(frozen=True)
class GenerateOutcome:
    spec: UISpec
    trace: ComposeTrace


@dataclass(frozen=True)
class _TraceBase:
    input: TraceInput
    intent: Intent
    refs: list[str]
    dataVersion: str
    cacheKey: str


@dataclass(frozen=True)
class PreparedCompose:
    """Shared preparation result for compose / compose_stream (normalization, reference resolution, cacheKey, cache lookup)."""

    intent: Intent
    refs: ResolvedRefs
    key: str
    trace_base: _TraceBase
    cache_mode: Literal["default", "bypass"]
    cache_label: Literal["miss", "bypass"]
    started_at: float
    policy: ComposePolicy
    abort: AbortSignal | None
    cached: tuple[UISpec, ComposeTrace] | None
    """On a cache hit, the Spec (with cache:"hit" applied) + the hit trace. None for miss/bypass."""
    on_draft_partial: OnDraftPartial | None = None
    """Notification target for the in-progress state of L1 generation (the LLM's cumulative partial draft)
    (incremental streaming). Only compose_stream wires it (assigned via replace after prepare_compose); compose()
    does not pass it = the non-stream path is completely unchanged. Under single-flight, only the leader's
    generation notifies."""


# ---------------------------------------------------------------------------
# single-flight (coalescing). A per-storage in-flight compose table (process-local).
# Concurrent composes for the same key are folded into a single generation, and followers ride along on the
# preceding compose's result. Generation runs on a shared AbortController's signal rather than the leader's
# personal signal, and generation is aborted only when all waiters abort (cancellation's blast radius is a vote).
# ---------------------------------------------------------------------------


@dataclass
class _InflightEntry:
    task: asyncio.Task[GenerateOutcome]
    controller: AbortController
    waiters: int = 0


_inflight_by_storage: weakref.WeakKeyDictionary[Any, dict[str, _InflightEntry]] = (
    weakref.WeakKeyDictionary()
)


def _inflight_map(storage: Any) -> dict[str, _InflightEntry]:
    table = _inflight_by_storage.get(storage)
    if table is None:
        table = {}
        _inflight_by_storage[storage] = table
    return table


def _join_inflight(entry: _InflightEntry, signal: AbortSignal | None) -> Callable[[], None]:
    """Joins an in-flight entry as a waiter. When the caller's signal aborts, decrement the waiter count, and
    when it reaches 0 abort the shared generation (stop generation only when the last one leaves).

    The return value is a release function to call when waiting ends (returns the count exactly once, whether on
    normal completion or abort).
    """
    entry.waiters += 1
    released = False

    def _noop() -> None:
        return None

    unsubscribe: Callable[[], None] = _noop

    def _on_abort() -> None:
        nonlocal released
        if released:
            return
        released = True
        entry.waiters -= 1
        if entry.waiters == 0:
            entry.controller.abort()

    def _release() -> None:
        nonlocal released
        if released:
            return
        released = True
        entry.waiters -= 1
        unsubscribe()

    if signal is not None:
        unsubscribe = signal.add_listener(_on_abort)
    return _release


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def compose(
    input: ComposeInput, base_ctx: ComposeContext, opts: ComposeOptions | None = None
) -> ComposeResult:
    opts = opts or ComposeOptions()
    # Swap to the tenant's catalog and the session's policy exactly once, then layer the caller's
    # policy_override on top (no transformation when the hooks/option are unwired). Must happen before
    # prepare_compose — the cache key reads policy.generatorVersion.
    ctx = (
        base_ctx.with_tenant_catalog(opts.session.tenant if opts.session is not None else None)
        .with_session_policy(opts.session)
        .with_policy_override(opts.policy_override)
    )
    try:
        prepared = await prepare_compose(input, ctx, opts)
        # 4. Cache lookup (a path with zero LLM calls)
        if prepared.cached is not None:
            spec, trace = prepared.cached
            return finish(spec, trace, ctx)
        # 5-10. L0/L1/L2 generation + cache store (coalesced under single-flight).
        outcome = await run_generation(prepared, ctx)
        return finish(outcome.spec, outcome.trace, ctx)
    except BaseException as e:
        # Notify the observer hook of a hard failure (an exception in normalize / reference resolution / final validation) and re-raise.
        report_compose_error(
            ctx, ComposeErrorContext(phase="hard", input=to_trace_input(input)), e
        )
        raise


async def prepare_compose(
    input: ComposeInput, ctx: ComposeContext, opts: ComposeOptions | None = None
) -> PreparedCompose:
    """The preparation stage up to normalized Intent, reference resolution, cacheKey, and cache lookup (shared by compose / stream)."""
    opts = opts or ComposeOptions()
    started_at = time.monotonic()
    policy = ctx.policy if ctx.policy is not None else ComposePolicy()

    # 1. Intent normalization (NL / GUI go through the SemanticPort; a structured Intent only recomputes the hash)
    if isinstance(input, IntentComposeInput):
        intent = finalize_intent(input.intent)
    else:
        try:
            session = opts.session if opts.session is not None else SessionContext(surface="web")
            normalized = await ctx.semantic.normalize(input, session)
            intent = finalize_intent(
                IntentInput(canonical=normalized.canonical, params=normalized.params)
            )
        except Exception as e:
            raise ComposeError("SEMANTIC_FAILED", "intent normalization failed", cause=e) from e

    # 2. Deterministic query resolution (reference-passing handles) + dataVersion composition.
    tenant = opts.session.tenant if opts.session is not None else None
    refs = await _resolve_refs(intent, ctx, tenant)

    # 3. Cache key (generatorVersion is appended as a trailing component only when given; policyFingerprint
    # is a derived 7th component — see context.py's policy_fingerprint doc — likewise omitted (empty
    # string) whenever the policy touches none of its fingerprinted fields, keeping the key unchanged).
    key = cache_key(
        CacheKeyParts(
            intentHash=intent.hash,
            dataVersion=refs.dataVersion,
            catalogFingerprint=ctx.catalog.fingerprint,
            generatorVersion=policy.generatorVersion,
            policyFingerprint=policy_fingerprint(policy, tier_llm_fingerprint_material(ctx)),
        )
    )

    trace_base = _TraceBase(
        input=to_trace_input(input),
        intent=intent,
        refs=refs.uris,
        dataVersion=refs.dataVersion,
        cacheKey=key,
    )

    # 4. Cache lookup (only when cacheMode==="default")
    cached: tuple[UISpec, ComposeTrace] | None = None
    if policy.cacheMode == "default":
        hit = await _get_spec_cache_safely(ctx, policy, trace_base, intent, key)
        if hit is not None:
            spec = hit.model_copy(update={"provenance": hit.provenance.model_copy(update={"cache": "hit"})})
            trace = ComposeTrace(
                input=trace_base.input,
                intent=intent,
                refs=refs.uris,
                dataVersion=refs.dataVersion,
                cacheKey=key,
                cache="hit",
                tier=hit.provenance.tier,
                attempts=[],
                durationMs=(time.monotonic() - started_at) * 1000,
            )
            cached = (spec, trace)
    cache_label: Literal["miss", "bypass"] = "bypass" if policy.cacheMode == "bypass" else "miss"

    return PreparedCompose(
        intent=intent,
        refs=refs,
        key=key,
        trace_base=trace_base,
        cache_mode=policy.cacheMode,
        cache_label=cache_label,
        started_at=started_at,
        policy=policy,
        abort=opts.abort,
        cached=cached,
    )


async def run_generation(prepared: PreparedCompose, ctx: ComposeContext) -> GenerateOutcome:
    """Runs generation under single-flight. When cacheMode="default", concurrent generations for the same key are folded into one.

    bypass respects the intent of a forced regeneration and does not coalesce (always runs as a leader-equivalent).
    """
    if prepared.cache_mode != "default":
        return await _generate_spec(prepared, ctx)

    table = _inflight_map(ctx.storage)
    existing = table.get(prepared.key)
    if existing is not None:
        # Follower: ride along on the preceding compose's result (the leader's exception also propagates here).
        # Our own signal is used only as an "abort vote for the shared generation".
        release = _join_inflight(existing, prepared.abort)
        try:
            shared = await asyncio.shield(existing.task)
            return _build_follower_outcome(shared, prepared)
        finally:
            release()

    # Leader: register the generation Task first, then run it, and always remove it from the table in finally.
    # Pass the shared controller's signal to generation rather than the leader's personal signal — so the
    # leader's client disconnect does not propagate as a fallback to healthy followers.
    controller = AbortController()
    leader_prepared = (
        replace(prepared, abort=controller.signal) if prepared.abort is not None else prepared
    )
    entry = _InflightEntry(
        task=asyncio.ensure_future(_generate_spec(leader_prepared, ctx)),
        controller=controller,
    )
    table[prepared.key] = entry

    # As soon as the last waiter leaves and the shared controller aborts, remove the entry immediately
    # rather than waiting for the task to settle. Without this, a new caller arriving in the window
    # between the abort firing and the (now-doomed, about-to-fall-back) task resolving would be coalesced
    # onto that cancelled result instead of becoming a fresh leader.
    def _remove_on_abort() -> None:
        if table.get(prepared.key) is entry:
            del table[prepared.key]

    controller.signal.add_listener(_remove_on_abort)

    release = _join_inflight(entry, prepared.abort)
    try:
        return await asyncio.shield(entry.task)
    finally:
        release()
        # Delete only when it is the entry we registered (do not erase a table a later leader replaced).
        if table.get(prepared.key) is entry:
            del table[prepared.key]


@dataclass(frozen=True)
class _TierOutcomeOk:
    """L1/L2 generation succeeded. tier records which stage actually settled."""

    tier: Literal["L1", "L2"]
    components: list[dict[str, Any]]
    events: list[dict[str, Any]]
    model: str | None
    kind: Literal["ok"] = "ok"


@dataclass(frozen=True)
class _TierOutcomeFallback:
    """L1/L2 generation settled as a deterministic fallback.

    from_tier is "the stage that actually failed" (mirrors TS TierOutcome's `from`; renamed because
    `from` is a Python keyword). budget_exceeded is True only when the fallback was caused by the budget
    guard (for observer.onError's machine discrimination, not string-matching on reason).
    """

    from_tier: Literal["L1", "L2"]
    reason: str
    budget_exceeded: bool = False
    cancelled: bool = False
    """True when the fallback was caused by the caller's AbortSignal firing (a client disconnect or
    timeout) rather than an actual generation failure. compose.py marks the resulting trace cancelled and
    hosts skip recording view.composed/view.fallback for it, so a cancel does not inflate the
    generation-fallback-rate analytics."""
    kind: Literal["fallback"] = "fallback"


type _TierOutcome = _TierOutcomeOk | _TierOutcomeFallback


def _tier_fallback(
    from_tier: Literal["L1", "L2"], reason: str, budget_exceeded: bool = False
) -> _TierOutcomeFallback:
    """Constructs the fallback form of a _TierOutcome (mirrors TS's `fallback()` helper)."""
    return _TierOutcomeFallback(from_tier=from_tier, reason=reason, budget_exceeded=budget_exceeded)


type _BudgetCheckErrorReporterFor = (
    Callable[[Literal["L1", "L2"]], Callable[[BaseException], None]] | None
)


async def _generate_spec(prepared: PreparedCompose, ctx: ComposeContext) -> GenerateOutcome:
    """The body of L0/L1/L2 generation + cache store. One call = the leader's generation (runs inside the
    single-flight leader/follower logic)."""
    # 5. L0: fixed Spec (a promoted, high-frequency, high-confidence path)
    fixed = await _try_fixed_spec(prepared, ctx)
    if fixed is not None:
        return fixed

    # 6-7. L1 constrained generation → L2 free-form generation → deterministic fallback (branching consolidated in _run_tier_generation).
    attempts: list[ComposeAttempt] = []
    outcome = await _run_tier_generation(prepared, ctx, attempts)
    spec = _build_spec_from_outcome(prepared, ctx, outcome)
    # 9-10. Cache store + leader trace assembly.
    return await _persist_and_trace(prepared, ctx, spec, outcome, attempts)


async def _get_spec_cache_safely(
    ctx: ComposeContext,
    policy: ComposePolicy,
    trace_base: _TraceBase,
    intent: Intent,
    key: str,
) -> UISpec | None:
    """Fail-open wrapper around ctx.storage.get_spec_cache: a raised error is reported to
    observer.onError (phase "cache") and treated as a cache miss, so a cache-backend outage does not
    turn every compose into a hard failure after a successful generation. policy.cacheFailure ==
    "closed" opts back into re-raising the original error instead."""
    try:
        return await ctx.storage.get_spec_cache(key)
    except Exception as e:
        report_compose_error(
            ctx,
            ComposeErrorContext(phase="cache", input=trace_base.input, intent=intent, cacheKey=key),
            e,
        )
        if policy.cacheFailure == "closed":
            raise
        return None


async def _put_spec_cache_safely(ctx: ComposeContext, prepared: PreparedCompose, spec: UISpec) -> None:
    """Fail-open wrapper around ctx.storage.put_spec_cache, mirroring _get_spec_cache_safely: a raised
    error is reported (phase "cache") and swallowed (the Spec was already generated and is still
    delivered), unless policy.cacheFailure == "closed", in which case it re-raises."""
    try:
        await ctx.storage.put_spec_cache(prepared.key, spec, ttl_seconds=prepared.policy.ttlSeconds)
    except Exception as e:
        report_compose_error(
            ctx,
            ComposeErrorContext(
                phase="cache",
                input=prepared.trace_base.input,
                intent=prepared.intent,
                cacheKey=prepared.key,
            ),
            e,
        )
        if prepared.policy.cacheFailure == "closed":
            raise


async def _try_fixed_spec(prepared: PreparedCompose, ctx: ComposeContext) -> GenerateOutcome | None:
    """The L0 fixed-Spec short-circuit. If lookup hits, runs all the way through assemble → post-processing →
    cache store → trace, and returns None on a miss (the caller proceeds to the L1/L2 ladder)."""
    intent = prepared.intent
    refs = prepared.refs
    policy = prepared.policy

    fixed = await policy.fixedSpecs.lookup(intent) if policy.fixedSpecs is not None else None
    if fixed is None:
        return None

    template = fixed(intent, refs.handles) if callable(fixed) else fixed
    assembled = _assemble_spec(
        intent=intent,
        refs=refs,
        components=[c.to_wire() for c in template.components],
        events=[e.to_wire() for e in template.events],
        tier="L0",
        cache=prepared.cache_label,
        # Carry the fixed template's state into the delivered Spec (preserve visibleWhen's initial state).
        state=template.state,
    )
    l0_spec = post_and_validate(assembled, refs, ctx)
    if _should_persist(l0_spec, prepared.cache_mode):
        await _put_spec_cache_safely(ctx, prepared, l0_spec)
    trace = _build_trace(prepared, tier="L0", attempts=[], fallback_reason=None, model=None)
    return GenerateOutcome(spec=l0_spec, trace=trace)


def _build_spec_from_outcome(
    prepared: PreparedCompose, ctx: ComposeContext, outcome: _TierOutcome
) -> UISpec:
    """Builds the delivered Spec from a _TierOutcome. On ok: assemble + post-processing; on fallback: returns
    the deterministic fallback Spec and fires the observer hook exactly once (the once-per-generation contract
    is fixed here)."""
    intent = prepared.intent
    refs = prepared.refs
    key = prepared.key

    if isinstance(outcome, _TierOutcomeOk):
        assembled = _assemble_spec(
            intent=intent,
            refs=refs,
            components=outcome.components,
            events=outcome.events,
            tier=outcome.tier,
            cache=prepared.cache_label,
            model=outcome.model,
        )
        return post_and_validate(assembled, refs, ctx)

    spec = build_fallback_spec(
        intent=intent,
        data_version=refs.dataVersion,
        reason=outcome.reason,
        composed_by=COMPOSER_ID,
        cache=prepared.cache_label,
        # Reflect the tier that actually failed in provenance.tier / fallback.from.
        from_tier=outcome.from_tier,
    )
    # Make the deterministic degradation on generation failure observable (once per generation = only the leader passes through).
    # phase is "cancelled" rather than "fallback" when the fallback was caused by the caller's abort
    # (client disconnect/timeout), so hosts can skip counting it against the generation-fallback rate.
    report_compose_error(
        ctx,
        ComposeErrorContext(
            phase="cancelled" if outcome.cancelled else "fallback",
            input=prepared.trace_base.input,
            intent=intent,
            cacheKey=key,
            tier=outcome.from_tier,
            reason=outcome.reason,
            budgetExceeded=outcome.budget_exceeded,
        ),
        None,
    )
    return spec


async def _persist_and_trace(
    prepared: PreparedCompose,
    ctx: ComposeContext,
    spec: UISpec,
    outcome: _TierOutcome,
    attempts: list[ComposeAttempt],
) -> GenerateOutcome:
    """After the cache store (condition/timing consolidated in _should_persist), builds the ComposeTrace for the
    leader. The L0 short-circuit does the equivalent store/trace on the _try_fixed_spec side, so this is dedicated
    to the L1/L2/fallback path."""
    if _should_persist(spec, prepared.cache_mode):
        await _put_spec_cache_safely(ctx, prepared, spec)

    fallback_reason = outcome.reason if isinstance(outcome, _TierOutcomeFallback) else None
    model = outcome.model if isinstance(outcome, _TierOutcomeOk) else None
    cancelled = outcome.cancelled if isinstance(outcome, _TierOutcomeFallback) else False
    trace = _build_trace(
        prepared,
        tier=spec.provenance.tier,
        attempts=attempts,
        fallback_reason=fallback_reason,
        model=model,
        cancelled=cancelled,
    )
    return GenerateOutcome(spec=spec, trace=trace)


async def _run_tier_generation(
    prepared: PreparedCompose, ctx: ComposeContext, attempts: list[ComposeAttempt]
) -> _TierOutcome:
    """The stage ladder of L1 constrained generation → L2 free-form generation. Order of attack:
    L1 (when route=L1) → L2 promotion eligibility → L2 budget check → L2 generation. attempts are pushed onto
    the caller's array (usage aggregation and trace inclusion are _generate_spec's responsibility)."""
    intent = prepared.intent
    key = prepared.key
    policy = prepared.policy
    budget = policy.budget

    def _budget_check_error_reporter_for(
        check_tier: Literal["L1", "L2"],
    ) -> Callable[[BaseException], None]:
        def _handler(error: BaseException) -> None:
            report_budget_check_error(
                ctx,
                BudgetCheckErrorContext(
                    input=prepared.trace_base.input, intent=intent, cacheKey=key, tier=check_tier
                ),
                error,
            )

        return _handler

    budget_check_error_reporter_for: _BudgetCheckErrorReporterFor = (
        _budget_check_error_reporter_for if budget is not None else None
    )

    route = (policy.routeTier(intent) if policy.routeTier is not None else None) or "L1"
    # The default value of "the tier that actually failed" recorded on fallback. If route is L2 direct entry,
    # L2 (L1 does not run). Fixed to "L2" only when L2 is actually run and fails (the L2 branch below).
    initial_from: Literal["L1", "L2"] = "L2" if route == "L2" else "L1"

    # Compose-wide deadline (ComposePolicy.budget.deadline_ms). Armed once for the whole L1→L2 ladder shared
    # below (the initial L1 call, every repair re-attempt, and L2) — not re-armed per attempt — so it bounds
    # the wall-clock time of this *compose*, not any single LLM call. See create_deadline_guard's doc
    # (budget.py) for how signal/deadline_signal are told apart at the classification site
    # (l1_generate.py/l2_generate.py). A no-op (byte-identical signal passthrough, no timer) whenever
    # budget.deadline_ms is unset.
    deadline_guard = create_deadline_guard(budget, prepared.started_at, prepared.abort)
    try:
        l1_outcome = await _run_l1_stage(
            prepared,
            ctx,
            attempts,
            route,
            initial_from,
            budget,
            budget_check_error_reporter_for,
            deadline_guard.signal,
            deadline_guard.deadline_signal,
        )
        if l1_outcome is not None:
            return l1_outcome

        return await _run_l2_stage(
            prepared,
            ctx,
            attempts,
            initial_from,
            budget,
            budget_check_error_reporter_for,
            deadline_guard.signal,
            deadline_guard.deadline_signal,
        )
    finally:
        # Always clear the timer once the ladder settles (success or fallback) so a deadline that never
        # fires does not leave a dangling handle.
        deadline_guard.dispose()


@dataclass(frozen=True)
class _L1Fallback:
    reason: str
    failure: Literal["transient", "invalid", "budget", "aborted"] | None
    budget_exceeded: bool


async def _run_l1_stage(
    prepared: PreparedCompose,
    ctx: ComposeContext,
    attempts: list[ComposeAttempt],
    route: Literal["L1", "L2"],
    initial_from: Literal["L1", "L2"],
    budget: ComposeBudget | None,
    budget_check_error_reporter_for: _BudgetCheckErrorReporterFor,
    signal: AbortSignal | None,
    deadline_signal: AbortSignal | None,
) -> _TierOutcome | None:
    """The L1 stage + L2 promotion-eligibility decision. Returns a settled _TierOutcome, or None when proceeding
    to L2. If route=L1, runs generate_l1 → an early return according to the failure kind. route=L2 direct entry
    does not generate and only passes the allowL2 decision.

    `signal` is create_deadline_guard's output (prepared.abort combined with a deadline timer when
    budget.deadline_ms is set, or prepared.abort unchanged otherwise) — passed to generate_l1 in place of
    prepared.abort directly. `deadline_signal` is forwarded for mid-call abort classification."""
    intent = prepared.intent
    refs = prepared.refs
    policy = prepared.policy

    # The L1 stage. Settle immediately on success; on failure, carry the kind and reason to the L2 promotion decision.
    l1_fallback: _L1Fallback | None = None
    if route == "L1":
        l1 = await generate_l1(
            intent,
            refs,
            ctx,
            signal,
            budget,
            budget_check_error_reporter_for("L1") if budget_check_error_reporter_for is not None else None,
            prepared.on_draft_partial,
            started_at=prepared.started_at,
            deadline_signal=deadline_signal,
        )
        attempts.extend(l1.attempts)
        if l1.ok:
            assert l1.components is not None
            return _TierOutcomeOk(
                tier="L1",
                components=l1.components,
                events=l1.events if l1.events is not None else [],
                model=l1.model,
            )
        if l1.failure == "aborted":
            # The caller's AbortSignal fired — a client disconnect/timeout, not a generation failure. Never
            # promoted to L2 (there is no one left to receive it), and marked cancelled so hosts skip
            # recording it as a generation fallback. Returned immediately, unlike the other failure kinds
            # below, because this decision does not depend on can_l2 at all.
            return _TierOutcomeFallback(
                from_tier=initial_from,
                reason="Generation cancelled by the caller",
                cancelled=True,
            )
        if l1.failure == "budget":
            # L1 was cut off due to budget overrun (first-attempt skip or repair skip). Not escalated to L2 either.
            l1_fallback = _L1Fallback(
                reason=l1.budgetReason
                if l1.budgetReason is not None
                else "Generation stopped: token budget exceeded",
                failure=l1.failure,
                budget_exceeded=True,
            )
        else:
            l1_fallback = _L1Fallback(
                reason="L1 constrained generation failed catalog/structure validation",
                failure=l1.failure,
                budget_exceeded=False,
            )

    # Try L2 only when allowL2 is enabled. Even if requested via route=="L2", if disabled, keep the reason.
    can_l2 = policy.allowL2
    if l1_fallback is not None and not can_l2:
        # In an environment where L2 is disabled, L1's failure reason becomes the final reason as-is.
        return _tier_fallback(initial_from, l1_fallback.reason, l1_fallback.budget_exceeded)
    # When L1 failed transiently (abort/provider failure), do not route to L2 (throwing another full generation
    # at a failing provider would only hit the same failure). Only a schema-derived (invalid) L1 failure is
    # promoted to L2 as before.
    if l1_fallback is not None and l1_fallback.failure == "transient":
        return _tier_fallback(
            initial_from, "Skipped L2 because L1 failed with a transient error (abort/provider)"
        )
    # If L1 stopped due to budget overrun, do not send it to L2 (the additional cost of full generation) either.
    if l1_fallback is not None and l1_fallback.failure == "budget":
        return _tier_fallback(initial_from, l1_fallback.reason, True)
    if not can_l2:
        # Only route=L2 direct entry reaches here (L1 success has already returned; L1 failure was already fixed above).
        return _tier_fallback(initial_from, "L2 (free-form generation) is disabled in this environment")

    return None


async def _run_l2_stage(
    prepared: PreparedCompose,
    ctx: ComposeContext,
    attempts: list[ComposeAttempt],
    initial_from: Literal["L1", "L2"],
    budget: ComposeBudget | None,
    budget_check_error_reporter_for: _BudgetCheckErrorReporterFor,
    signal: AbortSignal | None,
    deadline_signal: AbortSignal | None,
) -> _TierOutcome:
    """The L2 stage. Budget check → generate_l2. Always settles with a _TierOutcome (one of success / budget
    overrun / generation failure). `signal`/`deadline_signal` are create_deadline_guard's output — see
    `_run_l1_stage`'s doc for the same contract."""
    intent = prepared.intent
    refs = prepared.refs

    # Budget verdict before L2. Decides both L2-direct and L1(invalid)→L2 escalation together here. spent is
    # the usage consumed at L1 (accumulated in attempts). When budget is unset, skip the check (classic path).
    elapsed_ms = (
        (time.monotonic() - prepared.started_at) * 1000
        if budget is not None and budget.deadline_ms is not None
        else None
    )
    l2_verdict = (
        check_budget(
            budget,
            sum_spent_tokens(attempts),
            budget_check_error_reporter_for("L2") if budget_check_error_reporter_for is not None else None,
            elapsed_ms,
        )
        if budget is not None
        else None
    )
    if l2_verdict is not None and not l2_verdict.allow:
        # Skip L2 due to budget overrun. from_tier stays L1 if it stopped at L1 (L2 never actually ran).
        return _tier_fallback(
            initial_from,
            l2_verdict.reason if l2_verdict.reason is not None else "Skipped L2 escalation: token budget exceeded",
            True,
        )

    l2 = await generate_l2(
        intent,
        refs,
        ctx,
        signal,
        budget,
        budget_check_error_reporter_for("L2") if budget_check_error_reporter_for is not None else None,
        started_at=prepared.started_at,
        deadline_signal=deadline_signal,
    )
    attempts.extend(l2.attempts)
    if l2.ok:
        assert l2.components is not None
        return _TierOutcomeOk(
            tier="L2",
            components=l2.components,
            events=l2.events if l2.events is not None else [],
            model=l2.model,
        )
    if l2.failure == "aborted":
        # Same rationale as L1's "aborted" branch: a client disconnect/timeout, not a generation failure.
        return _TierOutcomeFallback(
            from_tier="L2",
            reason="Generation cancelled by the caller",
            cancelled=True,
        )
    if l2.failure == "budget":
        # L2's repair retry was cut off by budget. The "stage that actually failed" is L2.
        return _tier_fallback(
            "L2",
            l2.budgetReason if l2.budgetReason is not None else "Skipped L2 repair retry: token budget exceeded",
            True,
        )
    # Tried L2 and failed (align from_tier with reality).
    return _tier_fallback("L2", "L2 free-form generation failed")


def _build_trace(
    prepared: PreparedCompose,
    *,
    tier: Literal["L0", "L1", "L2"],
    attempts: list[ComposeAttempt],
    fallback_reason: str | None,
    model: str | None,
    cancelled: bool = False,
) -> ComposeTrace:
    return ComposeTrace(
        input=prepared.trace_base.input,
        intent=prepared.intent,
        refs=prepared.refs.uris,
        dataVersion=prepared.refs.dataVersion,
        cacheKey=prepared.key,
        cache=prepared.cache_label,
        tier=tier,
        fallback_reason=fallback_reason,
        attempts=attempts,
        model=model,
        usage=_sum_usage(attempts),
        durationMs=(time.monotonic() - prepared.started_at) * 1000,
        cancelled=cancelled,
    )


def _build_follower_outcome(shared: GenerateOutcome, prepared: PreparedCompose) -> GenerateOutcome:
    """Finalizes the follower's (coalesced) Spec/trace. A fallback keeps the leader's label instead of pretending to be a hit."""
    shared_spec = shared.spec
    is_fallback = shared_spec.provenance.fallback is not None
    spec = (
        shared_spec
        if is_fallback
        else shared_spec.model_copy(
            update={"provenance": shared_spec.provenance.model_copy(update={"cache": "hit"})}
        )
    )
    trace = ComposeTrace(
        input=prepared.trace_base.input,
        intent=prepared.intent,
        refs=prepared.refs.uris,
        dataVersion=prepared.refs.dataVersion,
        cacheKey=prepared.key,
        # Riding along on a normal generation is a hit (synonymous with a cache hit). A fallback keeps the leader's label.
        cache=prepared.cache_label if is_fallback else "hit",
        tier=shared_spec.provenance.tier,
        fallback_reason=shared_spec.provenance.fallback.reason
        if is_fallback and shared_spec.provenance.fallback is not None
        else None,
        attempts=[],
        coalesced=True,
        model=shared_spec.provenance.model,
        durationMs=(time.monotonic() - prepared.started_at) * 1000,
        # Propagate cancellation from the leader's trace so followers are equally excluded from lineage
        # recording and the fallback-rate analytics when the leader's generation was aborted.
        cancelled=shared.trace.cancelled,
    )
    return GenerateOutcome(spec=spec, trace=trace)


def negotiate_spec(spec: UISpec, ctx: ComposeContext, trace: ComposeTrace | None = None) -> UISpec:
    """Surface capability negotiation. Applied every time outside the cache (deterministic)."""
    if ctx.surface is None:
        return spec
    negotiated = negotiate(spec, ctx.catalog, ctx.surface)
    if trace is not None and len(negotiated.downgrades) > 0:
        trace.downgrades = negotiated.downgrades
    return negotiated.spec


def finish(spec: UISpec, trace: ComposeTrace, ctx: ComposeContext) -> ComposeResult:
    """Apply negotiate + observer notification → ComposeResult. Called exactly once on the final Spec."""
    result = negotiate_spec(spec, ctx, trace)
    hook = ctx.observer.onComposed if ctx.observer is not None else None
    if hook is not None:
        _fire_and_forget(lambda: hook(trace, result))
    return ComposeResult(spec=result, trace=trace)


def to_trace_input(input: ComposeInput) -> TraceInput:
    """Normalizes a ComposeInput into the form placed on trace/observer (drops the intent body and keeps only the kind)."""
    return "intent" if isinstance(input, IntentComposeInput) else input


def report_compose_error(
    ctx: ComposeContext, context: ComposeErrorContext, error: BaseException | None
) -> None:
    """Notifies the observer hook (observer.onError) of a compose failure (fire-and-forget)."""
    hook = ctx.observer.onError if ctx.observer is not None else None
    if hook is None:
        return
    _fire_and_forget(lambda: hook(context, error))


def report_budget_check_error(
    ctx: ComposeContext, context: BudgetCheckErrorContext, error: BaseException
) -> None:
    """Mirrors to the observer hook the firing where a throw from the budget hook check() was swallowed fail-open."""
    hook = ctx.observer.onBudgetCheckError if ctx.observer is not None else None
    if hook is None:
        return
    _fire_and_forget(lambda: hook(context, error))


def _fire_and_forget(invoke: Callable[[], Any]) -> None:
    """Does not let an observer-only hook's synchronous exception or async reject ripple into the compose body."""
    try:
        result = invoke()
        if inspect.isawaitable(result):
            task = asyncio.ensure_future(result)
            task.add_done_callback(lambda t: t.exception())  # absorb rejects (prevent unobserved warnings)
    except Exception:  # noqa: BLE001,S110 — do not override the result with an observer-only hook's exception
        pass


def _sum_usage(attempts: list[ComposeAttempt]) -> TokenUsage | None:
    """Sums the attempts' usage. None when no attempt carries usage."""
    has = False
    input_tokens = 0
    output_tokens = 0
    for a in attempts:
        if a.usage is None:
            continue
        has = True
        input_tokens += a.usage.inputTokens
        output_tokens += a.usage.outputTokens
    return TokenUsage(inputTokens=input_tokens, outputTokens=output_tokens) if has else None


@dataclass(frozen=True)
class RecomposePatch:
    params: dict[str, Any]
    canonical: str | None = None


async def recompose(
    prev: UISpec,
    patch: RecomposePatch,
    ctx: ComposeContext,
    opts: ComposeOptions | None = None,
    *,
    respect_prev_tier: bool = False,
) -> tuple[ComposeResult, SpecPatch]:
    """Interaction loop: Intent diff → Spec differential update.

    When respect_prev_tier=True and the previous Spec is L2, pin the differential update to the L2 path too
    (to prevent a screen that succeeded at L2 from dropping to L1 on every params change and being swapped for a different UI).
    """
    intent = IntentInput(
        canonical=patch.canonical if patch.canonical is not None else prev.intent.canonical,
        params={**prev.intent.params, **patch.params},
    )
    opts = opts or ComposeOptions()
    # The L2 pin is passed as a policy_override rather than folded into ctx up front, so that it
    # survives ComposeContext.with_policy_override's placement after with_session_policy even when
    # ctx.policyFor is wired (a session policy resolved from scratch would otherwise silently discard
    # this override).
    compose_opts = opts
    if respect_prev_tier and prev.provenance.tier == "L2":
        compose_opts = replace(
            opts,
            policy_override={
                **(opts.policy_override or {}),
                "routeTier": lambda _i: "L2",
                "allowL2": True,
            },
        )
    result = await compose(IntentComposeInput(intent=intent), ctx, compose_opts)
    return result, diff_spec(prev, result.spec)


async def _resolve_refs(
    intent: Intent, ctx: ComposeContext, tenant: str | None
) -> ResolvedRefs:
    try:
        resolved = await ctx.semantic.resolve_query(intent, tenant=tenant)
    except Exception as e:
        raise ComposeError("SEMANTIC_FAILED", "query resolution failed", cause=e) from e
    handles: list[QueryHandle] = resolved if isinstance(resolved, list) else [resolved]
    versions = list(await asyncio.gather(*(ctx.semantic.data_version(h) for h in handles)))
    data_version = combine_data_versions([(h.uri, versions[i]) for i, h in enumerate(handles)])
    versions_by_ref = {h.uri: versions[i] for i, h in enumerate(handles)}

    shapes_by_ref: dict[str, DataShape] = {}

    async def _shape(handle: QueryHandle) -> None:
        try:
            shape = await ctx.semantic.describe_shape(handle)
            if shape is not None:
                shapes_by_ref[handle.uri] = shape
        except Exception:  # noqa: BLE001,S110
            pass  # if the shape cannot be obtained, chart-kind rules etc. are skipped (an optional extension)

    await asyncio.gather(*(_shape(h) for h in handles))

    return ResolvedRefs(
        handles=handles,
        uris=[h.uri for h in handles],
        shapesByRef=shapes_by_ref,
        dataVersion=data_version,
        versionsByRef=versions_by_ref,
    )


def _should_persist(spec: UISpec, cache_mode: Literal["default", "bypass"]) -> bool:
    """Whether the Spec may be cache-stored. Do not store when bypass is specified or for a fallback Spec
    (to prevent an error screen produced by a transient LLM failure from being delivered forever under the same key)."""
    return cache_mode != "bypass" and spec.provenance.fallback is None


def _assemble_spec(
    *,
    intent: Intent,
    refs: ResolvedRefs,
    components: list[dict[str, Any]],
    events: list[dict[str, Any]],
    tier: Literal["L0", "L1", "L2"],
    cache: Literal["miss", "bypass"],
    model: str | None = None,
    state: dict[str, Any] | None = None,
) -> UISpec:
    wire: dict[str, Any] = {
        "kohaku": SPEC_VERSION,
        "intent": intent.to_wire(),
        "dataVersion": refs.dataVersion,
        # Always fill when there is at least one handle (include it even for a single ref to unify the renderer-side version matching)
        **({"refVersions": refs.versionsByRef} if len(refs.versionsByRef) > 0 else {}),
        **({"state": state} if state is not None else {}),
        "components": components,
        "events": events,
        "provenance": {
            "tier": tier,
            "composedBy": COMPOSER_ID,
            **({"model": model} if model is not None else {}),
            "cache": cache,
        },
    }
    return UISpec.model_validate(wire)


def post_and_validate(spec: UISpec, refs: ResolvedRefs, ctx: ComposeContext) -> UISpec:
    """Deterministic post-processing + final Spec validation. Running skeleton construction through the same path
    keeps component-version filling and props-default filling consistent with the generated Spec."""
    extra_rules = ctx.policy.extraRules if ctx.policy is not None else []
    processed = post_process(
        spec, PostProcessContext(catalog=ctx.catalog, shapesByRef=refs.shapesByRef), extra_rules
    )
    try:
        # Drop to wire form via a JSON round-trip (same as TS), then run final validation.
        return parse_spec(json.loads(json.dumps(processed.to_wire())))
    except Exception as e:
        raise ComposeError("INTERNAL", "composed spec failed final validation", cause=e) from e

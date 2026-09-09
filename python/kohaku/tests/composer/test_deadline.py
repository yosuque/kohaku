"""Tests for the compose-wide wall-clock deadline (ComposeBudget.deadline_ms).

A pytest port of packages/composer/test/deadline.test.ts's scenarios.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from kohaku.composer import (
    ComposeBudget,
    ComposeContext,
    ComposeErrorContext,
    ComposeObserver,
    ComposePolicy,
    check_budget,
    compose,
    compose_stream,
    create_deadline_guard,
)
from kohaku.llm import (
    AbortController,
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextRequest,
    GenerateTextResult,
    LlmError,
    LlmUsage,
)
from kohaku.storage import FileStoragePort

from .test_compose import _INTENT_INPUT, _ctx, _l1_draft

_BAD: dict[str, Any] = {"components": [], "events": []}  # empty components = catalog/structural-validation failure (repair-target invalid)


class TestCheckBudgetDeadlineUnit:
    def test_allows_when_elapsed_below_deadline(self) -> None:
        verdict = check_budget(ComposeBudget(deadline_ms=1000), 0, elapsed_ms=500)
        assert verdict.allow is True

    def test_rejects_with_deadline_specific_reason_once_elapsed_reaches_deadline(self) -> None:
        verdict = check_budget(ComposeBudget(deadline_ms=1000), 0, elapsed_ms=1000)
        assert verdict.allow is False
        assert verdict.reason is not None
        assert "budget exceeded" in verdict.reason.lower()
        assert "deadline" in verdict.reason.lower()

    def test_deadline_reason_distinguishable_from_token_threshold_reason(self) -> None:
        token_verdict = check_budget(ComposeBudget(per_compose_stop_after_tokens=10), 10)
        deadline_verdict = check_budget(ComposeBudget(deadline_ms=1000), 0, elapsed_ms=1000)
        assert token_verdict.reason != deadline_verdict.reason
        assert token_verdict.reason is not None and "token threshold" in token_verdict.reason.lower()
        assert deadline_verdict.reason is not None and "token threshold" not in deadline_verdict.reason.lower()

    def test_does_not_check_deadline_when_elapsed_ms_not_supplied(self) -> None:
        verdict = check_budget(ComposeBudget(deadline_ms=0), 0, elapsed_ms=None)
        assert verdict.allow is True

    def test_does_not_check_deadline_when_deadline_ms_unset(self) -> None:
        verdict = check_budget(ComposeBudget(), 0, elapsed_ms=999_999)
        assert verdict.allow is True

    def test_simultaneous_token_threshold_overage_takes_precedence(self) -> None:
        verdict = check_budget(
            ComposeBudget(per_compose_stop_after_tokens=10, deadline_ms=1000), 10, elapsed_ms=2000
        )
        assert verdict.allow is False
        assert verdict.reason is not None and "token threshold" in verdict.reason.lower()


class TestCreateDeadlineGuardUnit:
    def test_unset_deadline_returns_caller_signal_unchanged_and_noop_disposer(self) -> None:
        controller = AbortController()
        guard = create_deadline_guard(None, time.monotonic(), controller.signal)
        assert guard.signal is controller.signal
        assert guard.deadline_signal is None
        guard.dispose()  # must not raise

    def test_budget_set_but_deadline_ms_unset_still_passes_caller_signal_unchanged(self) -> None:
        controller = AbortController()
        guard = create_deadline_guard(
            ComposeBudget(per_compose_stop_after_tokens=100), time.monotonic(), controller.signal
        )
        assert guard.signal is controller.signal
        assert guard.deadline_signal is None

    def test_deadline_set_no_caller_signal_signal_and_deadline_signal_are_the_same(self) -> None:
        async def run() -> None:
            guard = create_deadline_guard(ComposeBudget(deadline_ms=1000), time.monotonic(), None)
            try:
                assert guard.signal is not None
                assert guard.signal is guard.deadline_signal
                assert guard.signal.aborted is False
            finally:
                guard.dispose()

        asyncio.run(run())

    def test_timer_fires_aborting_deadline_signal_once_remaining_time_elapses(self) -> None:
        async def run() -> None:
            guard = create_deadline_guard(ComposeBudget(deadline_ms=10), time.monotonic(), None)
            try:
                assert guard.deadline_signal is not None
                event = asyncio.get_running_loop().create_future()
                guard.deadline_signal.add_listener(lambda: event.set_result(None) if not event.done() else None)
                await asyncio.wait_for(event, timeout=5)
                assert guard.deadline_signal.aborted is True
            finally:
                guard.dispose()

        asyncio.run(run())

    def test_computes_remaining_time_from_injectable_clock_not_real_time(self) -> None:
        # On the injected clock, started_at is already 5s in the past and deadline_ms is 5000, so the
        # remaining time is clamped to 0 and the timer must fire almost immediately in real time — proving
        # remaining_ms is derived from `now`, not from real wall-clock elapsed time (which is ~0 here).
        async def run() -> None:
            started_at = 1_000_000.0

            def now() -> float:
                return started_at + 5.0

            guard = create_deadline_guard(ComposeBudget(deadline_ms=5_000), started_at, None, now)
            try:
                assert guard.deadline_signal is not None
                event = asyncio.get_running_loop().create_future()
                guard.deadline_signal.add_listener(lambda: event.set_result(None) if not event.done() else None)
                await asyncio.wait_for(event, timeout=5)
                assert guard.deadline_signal.aborted is True
            finally:
                guard.dispose()

        asyncio.run(run())

    def test_dispose_clears_the_timer_so_it_never_fires_afterward(self) -> None:
        async def run() -> None:
            guard = create_deadline_guard(ComposeBudget(deadline_ms=5), time.monotonic(), None)
            guard.dispose()
            await asyncio.sleep(0.02)
            assert guard.deadline_signal is not None
            assert guard.deadline_signal.aborted is False

        asyncio.run(run())


class TestComposeDeadlineGuardBackwardCompatibility:
    def test_budget_unspecified_no_deadline_check_performed(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.llm import FakeLlm

            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_BAD, _l1_draft()])
            result = await compose(_INTENT_INPUT, _ctx(llm, storage))
            assert len(result.trace.attempts) == 2
            assert result.spec.provenance.tier == "L1"
            assert result.spec.provenance.fallback is None

        asyncio.run(run())

    def test_deadline_ms_unspecified_other_budget_fields_set_deadline_checking_stays_off(
        self, tmp_path: Any
    ) -> None:
        async def run() -> None:
            from kohaku.llm import FakeLlm

            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_BAD, _l1_draft()])
            ctx = _ctx(
                llm, storage, ComposePolicy(budget=ComposeBudget(per_compose_stop_after_tokens=1_000_000))
            )
            result = await compose(_INTENT_INPUT, ctx)
            assert len(result.trace.attempts) == 2
            assert result.spec.provenance.tier == "L1"
            assert result.spec.provenance.fallback is None

        asyncio.run(run())

    def test_generous_deadline_never_trips_during_normal_fast_compose(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.llm import FakeLlm

            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_BAD, _l1_draft()])
            ctx = _ctx(llm, storage, ComposePolicy(budget=ComposeBudget(deadline_ms=60_000)))
            result = await compose(_INTENT_INPUT, ctx)
            assert len(result.trace.attempts) == 2
            assert result.spec.provenance.tier == "L1"
            assert result.spec.provenance.fallback is None

        asyncio.run(run())


class TestComposeDeadlineGuardBetweenCallEnforcement:
    def test_deadline_ms_zero_falls_back_without_calling_llm(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.llm import FakeLlm

            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage, ComposePolicy(budget=ComposeBudget(deadline_ms=0)))
            result = await compose(_INTENT_INPUT, ctx)

            assert len(llm.calls) == 0
            assert len(result.trace.attempts) == 0
            fb = result.spec.provenance.fallback
            assert fb is not None
            assert fb.from_ == "L1"
            assert "budget exceeded" in fb.reason.lower()
            assert "deadline" in fb.reason.lower()
            # A between-call deadline skip is a budget-guard downgrade, not a caller cancellation.
            assert result.trace.cancelled is False

        asyncio.run(run())

    def test_deadline_ms_zero_with_route_l2_direct_entry_falls_back_from_l2(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.llm import FakeLlm

            storage = FileStoragePort(tmp_path)
            llm = FakeLlm()
            ctx = _ctx(
                llm,
                storage,
                ComposePolicy(allowL2=True, routeTier=lambda _i: "L2", budget=ComposeBudget(deadline_ms=0)),
            )
            result = await compose(_INTENT_INPUT, ctx)

            assert len(llm.calls) == 0
            assert result.spec.provenance.tier == "L2"
            fb = result.spec.provenance.fallback
            assert fb is not None
            assert fb.from_ == "L2"
            assert "deadline" in fb.reason.lower()

        asyncio.run(run())

    def test_observer_on_error_receives_budget_exceeded_for_between_call_deadline_skip(
        self, tmp_path: Any
    ) -> None:
        async def run() -> None:
            from kohaku.llm import FakeLlm

            captured: list[ComposeErrorContext] = []
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            base = _ctx(llm, storage, ComposePolicy(budget=ComposeBudget(deadline_ms=0)))
            ctx: ComposeContext = ComposeContext(
                catalog=base.catalog,
                semantic=base.semantic,
                storage=base.storage,
                llm=base.llm,
                policy=base.policy,
                observer=ComposeObserver(onError=lambda c, _e: captured.append(c)),
            )
            await compose(_INTENT_INPUT, ctx)

            assert len(captured) == 1
            assert captured[0].phase == "fallback"
            assert captured[0].budgetExceeded is True
            assert captured[0].reason is not None and "deadline" in captured[0].reason.lower()

        asyncio.run(run())

    def test_deadline_exceeded_between_initial_attempt_and_repair_skips_repair_retry(
        self, tmp_path: Any, monkeypatch: Any
    ) -> None:
        # A custom LlmPort that advances a fake clock past the deadline while "in" its own call, so the
        # between-call check ahead of the repair attempt sees an elapsed time past budget.deadline_ms — this
        # is a deterministic stand-in for real wall-clock time elapsing during a real network call.
        async def run() -> None:
            clock = {"value": time.monotonic()}
            monkeypatch.setattr(time, "monotonic", lambda: clock["value"])
            calls = 0

            class _ClockLlm:
                provider = "clock"
                model_id = "clock-model"

                async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
                    nonlocal calls
                    calls += 1
                    clock["value"] += 0.06  # exceeds the 50ms deadline before the next attempt's check runs
                    return GenerateObjectResult(
                        object=_BAD, usage=LlmUsage(input_tokens=0, output_tokens=0), model="clock-model"
                    )

                async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
                    raise NotImplementedError("clock stub: generate_text not supported")

            storage = FileStoragePort(tmp_path)
            ctx = _ctx(_ClockLlm(), storage, ComposePolicy(budget=ComposeBudget(deadline_ms=50)))
            result = await compose(_INTENT_INPUT, ctx)

            # Only the initial attempt ran; the repair re-attempt was skipped by the between-call deadline check.
            assert calls == 1
            assert len(result.trace.attempts) == 1
            fb = result.spec.provenance.fallback
            assert fb is not None
            assert fb.from_ == "L1"
            assert "deadline" in fb.reason.lower()
            assert result.trace.cancelled is False

        asyncio.run(run())


class _HangingUntilAbortLlm:
    """An LlmPort whose generate_object only ever settles when its req.abort signal fires (rejecting
    ABORTED) — a deterministic stand-in for a real network call that is still in flight when a deadline
    elapses."""

    provider = "hanging"
    model_id = "hanging-model"

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        if req.abort is not None and req.abort.aborted:
            raise LlmError("ABORTED", "aborted(test)")
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        def _on_abort() -> None:
            if not future.done():
                future.set_result(None)

        if req.abort is not None:
            req.abort.add_listener(_on_abort)
        await future
        raise LlmError("ABORTED", "aborted(test)")

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        raise NotImplementedError("hanging stub: generate_text not supported")


class TestComposeDeadlineGuardInFlightAbort:
    def test_deadline_elapsing_mid_call_is_classified_as_budget_fallback_not_cancellation(
        self, tmp_path: Any
    ) -> None:
        async def run() -> None:
            captured: list[ComposeErrorContext] = []
            storage = FileStoragePort(tmp_path)
            base = _ctx(
                _HangingUntilAbortLlm(), storage, ComposePolicy(budget=ComposeBudget(deadline_ms=20))
            )
            ctx: ComposeContext = ComposeContext(
                catalog=base.catalog,
                semantic=base.semantic,
                storage=base.storage,
                llm=base.llm,
                policy=base.policy,
                observer=ComposeObserver(onError=lambda c, _e: captured.append(c)),
            )

            result = await compose(_INTENT_INPUT, ctx)

            fb = result.spec.provenance.fallback
            assert fb is not None
            assert fb.from_ == "L1"
            assert "budget exceeded" in fb.reason.lower()
            assert "deadline" in fb.reason.lower()
            assert "during generation" in fb.reason.lower()
            # The subtlety this whole feature hinges on: an in-flight deadline abort must NOT be marked
            # cancelled (that is reserved for a genuine caller AbortSignal / client disconnect) so hosts do
            # not skip lineage recording for it, and it must count toward the fallback-rate analytics.
            assert result.trace.cancelled is False
            assert result.trace.fallback_reason is not None and "deadline" in result.trace.fallback_reason.lower()
            assert len(captured) == 1
            assert captured[0].phase == "fallback"
            assert captured[0].budgetExceeded is True

        asyncio.run(asyncio.wait_for(run(), timeout=10))

    def test_genuine_caller_abort_firing_first_is_still_classified_as_cancelled(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.composer import ComposeOptions

            captured: list[ComposeErrorContext] = []
            storage = FileStoragePort(tmp_path)
            controller = AbortController()
            # A deadline generous enough that it would not fire before the caller's own abort below.
            base = _ctx(
                _HangingUntilAbortLlm(), storage, ComposePolicy(budget=ComposeBudget(deadline_ms=60_000))
            )
            ctx: ComposeContext = ComposeContext(
                catalog=base.catalog,
                semantic=base.semantic,
                storage=base.storage,
                llm=base.llm,
                policy=base.policy,
                observer=ComposeObserver(onError=lambda c, _e: captured.append(c)),
            )

            compose_task = asyncio.ensure_future(compose(_INTENT_INPUT, ctx, ComposeOptions(abort=controller.signal)))
            controller.abort()  # the caller cancels almost immediately, well before the 60s deadline
            result = await compose_task

            fb = result.spec.provenance.fallback
            assert fb is not None
            assert fb.from_ == "L1"
            assert result.trace.cancelled is True
            assert len(captured) == 1
            assert captured[0].phase == "cancelled"

        asyncio.run(asyncio.wait_for(run(), timeout=10))


class TestComposeStreamDeadlineGuard:
    def test_deadline_ms_zero_downgrade_flows_as_skeleton_to_fallback_patch(self, tmp_path: Any) -> None:
        async def run() -> None:
            from kohaku.llm import FakeLlm

            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage, ComposePolicy(budget=ComposeBudget(deadline_ms=0)))
            events = [e async for e in compose_stream(_INTENT_INPUT, ctx)]

            assert len(llm.calls) == 0
            assert [e.kind for e in events] == ["spec", "patch", "done"]
            done = events[2]
            assert done.kind == "done"
            fb = done.result.spec.provenance.fallback
            assert fb is not None and "deadline" in fb.reason.lower()
            assert done.result.trace.cancelled is False

        asyncio.run(run())

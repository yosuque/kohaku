"""Tests for kohaku.host_core.policy (port of packages/host-core/test/policy.test.ts)."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

import pytest
from pydantic import ValidationError

from kohaku.composer import (
    BudgetCheckContext,
    BudgetVerdict,
    ComposeBudget,
    ComposePolicy,
    TokenUsage,
)
from kohaku.host_core import PolicyAppliedEvent, create_policy_runtime, parse_policy
from kohaku.host_core.daily_token_ledger import create_daily_token_ledger
from kohaku.host_core.policy import PolicyRateLimiterTakeParams
from kohaku.spec import (
    KohakuPolicyFile,
    RateLimitResult,
    RateLimitRule,
    RateLimitStore,
    SessionContext,
)


def make_file(**overrides: Any) -> KohakuPolicyFile:
    base: dict[str, Any] = {"version": 1, "defaults": {}}
    base.update(overrides)
    return KohakuPolicyFile.model_validate(base)


def _ctx() -> BudgetCheckContext:
    """A minimal BudgetCheckContext for exercising a ComposeBudget.check_with_context directly (the
    tests below call it without going through kohaku.composer.check_budget)."""
    return BudgetCheckContext(tier="L1", spent_tokens=0)


def test_parse_policy_validates_and_computes_a_policy_id() -> None:
    parsed = parse_policy({"version": 1, "defaults": {"compose": {"allowL2": True}}})
    assert parsed.file.defaults.compose is not None
    assert parsed.file.defaults.compose.allowL2 is True
    assert parsed.policy_id.startswith("sha256:")
    assert len(parsed.policy_id) == len("sha256:") + 64


def test_parse_policy_raises_on_invalid_input() -> None:
    with pytest.raises(ValidationError):
        parse_policy({"version": 1, "defaults": {}, "bogus": True})


class TestPolicyFor:
    def test_layers_compose_onto_base_keeping_function_shaped_fields(self) -> None:
        def route_tier(intent: Any) -> Literal["L1", "L2"] | None:
            return "L2"

        runtime = create_policy_runtime(
            make_file(defaults={"compose": {"allowL2": True, "outputLanguage": "Japanese"}}),
            base_policy_for=lambda _t: ComposePolicy(routeTier=route_tier),
        )
        policy = runtime.policy_for()
        assert policy.allowL2 is True
        assert policy.outputLanguage == "Japanese"
        assert policy.routeTier is route_tier

    def test_tenant_section_overrides_defaults_for_that_tenant_only(self) -> None:
        runtime = create_policy_runtime(
            make_file(
                defaults={"compose": {"allowL2": True}},
                tenants={"tenant-a": {"compose": {"allowL2": False}}},
            )
        )
        assert runtime.policy_for(SessionContext(surface="web", tenant="tenant-a")).allowL2 is False
        assert runtime.policy_for(SessionContext(surface="web", tenant="tenant-b")).allowL2 is True
        assert runtime.policy_for().allowL2 is True

    def test_unset_data_field_falls_back_to_base(self) -> None:
        runtime = create_policy_runtime(
            make_file(), base_policy_for=lambda _t: ComposePolicy(allowL2=True, maxRepairAttempts=3)
        )
        policy = runtime.policy_for()
        assert policy.allowL2 is True
        assert policy.maxRepairAttempts == 3

    def test_memoized_per_tenant_and_base_object(self) -> None:
        base = ComposePolicy(allowL2=True)
        runtime = create_policy_runtime(make_file(), base_policy_for=lambda _t: base)
        session = SessionContext(surface="web", tenant="t1")
        first = runtime.policy_for(session)
        second = runtime.policy_for(session)
        assert second is first

    def test_recomputes_when_base_policy_for_returns_a_different_object(self) -> None:
        state = {"base": ComposePolicy(allowL2=True)}
        runtime = create_policy_runtime(make_file(), base_policy_for=lambda _t: state["base"])
        first = runtime.policy_for()
        state["base"] = ComposePolicy(allowL2=True)
        second = runtime.policy_for()
        assert second is not first
        assert second == first

    def test_recomputes_after_reload_even_with_a_stable_base_object(self) -> None:
        async def run() -> None:
            base = ComposePolicy()
            runtime = create_policy_runtime(
                make_file(defaults={"compose": {"allowL2": False}}), base_policy_for=lambda _t: base
            )
            before = runtime.policy_for()
            assert before.allowL2 is False
            await runtime.reload(make_file(defaults={"compose": {"allowL2": True}}))
            after = runtime.policy_for()
            assert after is not before
            assert after.allowL2 is True

        asyncio.run(run())


class TestBudget:
    def test_per_compose_and_deadline_from_file_override_base(self) -> None:
        runtime = create_policy_runtime(
            make_file(
                defaults={"compose": {"budget": {"perCompose": {"stopAfterTokens": 10}, "deadlineMs": 5000}}}
            ),
            base_policy_for=lambda _t: ComposePolicy(
                budget=ComposeBudget(per_compose_stop_after_tokens=999, deadline_ms=999)
            ),
        )
        budget = runtime.policy_for().budget
        assert budget is not None
        assert budget.per_compose_stop_after_tokens == 10
        assert budget.deadline_ms == 5000

    def test_per_compose_and_deadline_fall_back_to_base_when_file_leaves_budget_unset(self) -> None:
        runtime = create_policy_runtime(
            make_file(),
            base_policy_for=lambda _t: ComposePolicy(
                budget=ComposeBudget(per_compose_stop_after_tokens=999, deadline_ms=999)
            ),
        )
        budget = runtime.policy_for().budget
        assert budget is not None
        assert budget.per_compose_stop_after_tokens == 999
        assert budget.deadline_ms == 999

    def test_daily_tokens_denies_once_the_ledger_reaches_the_threshold(self) -> None:
        ledger = create_daily_token_ledger(now=lambda: 0)
        runtime = create_policy_runtime(
            make_file(defaults={"compose": {"budget": {"dailyTokens": 100}}}), ledger=ledger
        )
        budget = runtime.policy_for(SessionContext(surface="web", tenant="t1")).budget
        assert budget is not None and budget.check_with_context is not None
        assert budget.check_with_context(_ctx()).allow is True
        ledger.record("t1", 100)
        verdict = budget.check_with_context(_ctx())
        assert verdict.allow is False
        assert verdict.reason is not None and "daily token threshold" in verdict.reason.lower()

    def test_daily_tokens_is_scoped_per_tenant(self) -> None:
        ledger = create_daily_token_ledger(now=lambda: 0)
        runtime = create_policy_runtime(
            make_file(defaults={"compose": {"budget": {"dailyTokens": 10}}}), ledger=ledger
        )
        ledger.record("t1", 10)
        b1 = runtime.policy_for(SessionContext(surface="web", tenant="t1")).budget
        b2 = runtime.policy_for(SessionContext(surface="web", tenant="t2")).budget
        assert b1 is not None and b1.check_with_context is not None
        assert b1.check_with_context(_ctx()).allow is False
        assert b2 is not None and b2.check_with_context is not None
        assert b2.check_with_context(_ctx()).allow is True

    def test_on_usage_records_into_ledger_combined_with_base(self) -> None:
        ledger = create_daily_token_ledger(now=lambda: 0)
        base_calls: list[Any] = []
        runtime = create_policy_runtime(
            make_file(defaults={"compose": {"budget": {"dailyTokens": 1000}}}),
            base_policy_for=lambda _t: ComposePolicy(
                budget=ComposeBudget(on_usage=lambda t, u: base_calls.append((t, u)))
            ),
            ledger=ledger,
        )
        budget = runtime.policy_for(SessionContext(surface="web", tenant="t1")).budget
        assert budget is not None and budget.on_usage is not None
        budget.on_usage("t1", TokenUsage(inputTokens=3, outputTokens=4))
        assert len(base_calls) == 1
        assert ledger.spent("t1") == 7

    def test_daily_tokens_is_a_soft_limit_under_concurrency(self) -> None:
        """design.md #69: check_with_context() must stay side-effect-free, so it cannot reserve a
        slice of the budget -- N in-flight composes for one tenant can all observe the same
        pre-usage spent() value and all pass, before any of them calls on_usage. The overshoot is
        bounded by (concurrent in-flight generations) x (the per-compose token ceiling); mirrors the
        TS test of the same intent."""
        ledger = create_daily_token_ledger(now=lambda: 0)
        stop_after_tokens = 1000
        runtime = create_policy_runtime(
            make_file(
                defaults={"compose": {"budget": {"dailyTokens": 1, "perCompose": {"stopAfterTokens": stop_after_tokens}}}}
            ),
            ledger=ledger,
        )
        budget = runtime.policy_for(SessionContext(surface="web", tenant="t1")).budget
        assert budget is not None and budget.check_with_context is not None and budget.on_usage is not None
        concurrent_generations = 3

        # All N in-flight generations call check_with_context() while the ledger still reads 0
        # spent -- none of them has recorded usage yet, so every one is allowed, even though a
        # dailyTokens threshold of 1 would deny every generation after the first if run serially.
        verdicts = [budget.check_with_context(_ctx()) for _ in range(concurrent_generations)]
        assert all(v.allow for v in verdicts)

        # Only once each "completes" does on_usage record -- up to the per-compose ceiling each.
        for _ in range(concurrent_generations):
            budget.on_usage("t1", TokenUsage(inputTokens=stop_after_tokens, outputTokens=0))

        overshoot = ledger.spent("t1") - 1  # dailyTokens threshold was 1
        assert overshoot > 0
        assert overshoot <= concurrent_generations * stop_after_tokens

    def test_base_check_denial_wins_over_daily_tokens(self) -> None:
        ledger = create_daily_token_ledger(now=lambda: 0)
        runtime = create_policy_runtime(
            make_file(defaults={"compose": {"budget": {"dailyTokens": 1_000_000}}}),
            base_policy_for=lambda _t: ComposePolicy(
                budget=ComposeBudget(check=lambda: BudgetVerdict(allow=False, reason="base says no"))
            ),
            ledger=ledger,
        )
        budget = runtime.policy_for(SessionContext(surface="web", tenant="t1")).budget
        assert budget is not None and budget.check_with_context is not None
        verdict = budget.check_with_context(_ctx())
        assert verdict == BudgetVerdict(allow=False, reason="base says no")

    def test_budget_left_unset_when_nothing_declares_anything(self) -> None:
        runtime = create_policy_runtime(make_file())
        assert runtime.policy_for().budget is None


class TestRolesFor:
    def test_merges_defaults_and_tenant_roles(self) -> None:
        runtime = create_policy_runtime(
            make_file(
                defaults={"governance": {"roles": {"admin": ["*"]}}},
                tenants={"tenant-a": {"governance": {"roles": {"viewer": ["lineage.read"]}}}},
            )
        )
        assert runtime.roles_for("tenant-a") == {"admin": ["*"], "viewer": ["lineage.read"]}
        assert runtime.roles_for("tenant-b") == {"admin": ["*"]}

    def test_empty_when_nothing_declares_governance(self) -> None:
        runtime = create_policy_runtime(make_file())
        assert runtime.roles_for() == {}


class _RecordingStore:
    def __init__(self, allow: bool = True) -> None:
        self.allow = allow
        self.calls: list[dict[str, Any]] = []

    async def take(self, key: str, cost: int, rule: RateLimitRule, now_ms: float) -> RateLimitResult:
        self.calls.append({"key": key, "cost": cost, "rule": rule, "now_ms": now_ms})
        return RateLimitResult(allow=self.allow)


class TestRateLimiter:
    def test_always_allows_without_a_rate_limit_store(self) -> None:
        async def run() -> None:
            runtime = create_policy_runtime(
                make_file(defaults={"rateLimits": {"compose": {"capacity": 1, "refillPerSecond": 1}}})
            )
            result = await runtime.rate_limiter.take(PolicyRateLimiterTakeParams(routeClass="compose"))
            assert result == RateLimitResult(allow=True)

        asyncio.run(run())

    def test_always_allows_when_route_class_has_no_configured_rule(self) -> None:
        async def run() -> None:
            store: RateLimitStore = _RecordingStore(allow=False)
            runtime = create_policy_runtime(
                make_file(defaults={"rateLimits": {"compose": {"capacity": 1, "refillPerSecond": 1}}}),
                rate_limit_store=store,
            )
            result = await runtime.rate_limiter.take(PolicyRateLimiterTakeParams(routeClass="action"))
            assert result == RateLimitResult(allow=True)

        asyncio.run(run())

    def test_enforces_the_tenants_effective_rule_via_the_store(self) -> None:
        async def run() -> None:
            store = _RecordingStore()
            runtime = create_policy_runtime(
                make_file(
                    defaults={"rateLimits": {"compose": {"capacity": 5, "refillPerSecond": 1}}},
                    tenants={"tenant-a": {"rateLimits": {"compose": {"capacity": 1, "refillPerSecond": 2}}}},
                ),
                rate_limit_store=store,
            )
            await runtime.rate_limiter.take(
                PolicyRateLimiterTakeParams(tenant="tenant-a", principal="p1", routeClass="compose")
            )
            assert len(store.calls) == 1
            assert store.calls[0]["key"] == "tenant-a:p1:compose"
            assert store.calls[0]["rule"] == RateLimitRule(capacity=1, refillPerSecond=2)

        asyncio.run(run())


class TestReload:
    def test_no_op_when_new_file_is_byte_identical(self) -> None:
        async def run() -> None:
            events: list[PolicyAppliedEvent] = []
            runtime = create_policy_runtime(
                make_file(defaults={"compose": {"allowL2": True}}),
                audit=lambda e, a: events.append(e),
            )
            await runtime.reload(make_file(defaults={"compose": {"allowL2": True}}))
            assert events == []

        asyncio.run(run())

    def test_fires_audit_with_the_expected_event_shape(self) -> None:
        async def run() -> None:
            events: list[tuple[PolicyAppliedEvent, str | None]] = []
            runtime = create_policy_runtime(
                make_file(label="v1", defaults={"compose": {"allowL2": False}}),
                audit=lambda e, a: events.append((e, a)),
            )
            previous_policy_id = runtime.policy_id

            await runtime.reload(
                make_file(
                    label="v2",
                    defaults={"compose": {"allowL2": True}},
                    tenants={"tenant-a": {"compose": {"allowL2": False}}},
                ),
                "alice",
            )

            assert len(events) == 1
            event, actor = events[0]
            assert actor == "alice"
            assert event.previousPolicyId == previous_policy_id
            assert event.policyId == runtime.policy_id
            assert event.policyId != previous_policy_id
            assert event.version == 1
            assert event.label == "v2"
            assert event.tenants == ["tenant-a"]
            assert sorted(event.changedPaths) == sorted(["label", "defaults.compose.allowL2", "tenants"])

        asyncio.run(run())

    def test_policy_id_reflects_the_current_file(self) -> None:
        async def run() -> None:
            runtime = create_policy_runtime(make_file())
            before = runtime.policy_id
            await runtime.reload(make_file(label="changed"))
            assert runtime.policy_id != before

        asyncio.run(run())

    def test_first_reloads_previous_policy_id_is_the_constructor_files_policy_id(self) -> None:
        async def run() -> None:
            events: list[PolicyAppliedEvent] = []
            runtime = create_policy_runtime(make_file(), audit=lambda e, a: events.append(e))
            initial_policy_id = runtime.policy_id
            await runtime.reload(make_file(label="new"))
            assert events[0].previousPolicyId == initial_policy_id

        asyncio.run(run())

    def test_a_raising_audit_hook_propagates_out_of_reload(self) -> None:
        async def run() -> None:
            def boom(event: PolicyAppliedEvent, actor: str | None) -> None:
                raise RuntimeError("audit sink down")

            runtime = create_policy_runtime(make_file(), audit=boom)
            with pytest.raises(RuntimeError, match="audit sink down"):
                await runtime.reload(make_file(label="new"))

        asyncio.run(run())

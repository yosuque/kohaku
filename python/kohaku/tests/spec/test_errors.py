"""Tests for IntentValidationError / SupportsValidateIntent (port of packages/spec-core/test/intent-validation.test.ts)."""

from __future__ import annotations

import asyncio

from kohaku.spec.errors import IntentValidationError, IntentValidationIssue
from kohaku.spec.intent import IntentInput
from kohaku.spec.ports import SessionContext


def test_intent_validation_error_carries_the_intent_invalid_code_and_a_client_safe_message() -> None:
    error = IntentValidationError('unknown intent "sales.bogus"')
    assert isinstance(error, Exception)
    assert error.code == "INTENT_INVALID"
    assert str(error) == 'unknown intent "sales.bogus"'
    assert error.issues == []


def test_intent_validation_error_carries_per_param_issues_when_given() -> None:
    error = IntentValidationError(
        "invalid params for sales.trend",
        [
            IntentValidationIssue(path="metric", message='param "metric": expected one of revenue, units'),
            IntentValidationIssue(path="region", message='unknown param "region"'),
        ],
    )
    assert error.issues == [
        IntentValidationIssue(path="metric", message='param "metric": expected one of revenue, units'),
        IntentValidationIssue(path="region", message='unknown param "region"'),
    ]


def test_intent_validation_error_has_a_string_code_matching_the_is_typed_host_error_convention() -> None:
    error = IntentValidationError("boom")
    assert isinstance(error.code, str)


SESSION = SessionContext(surface="web")


def test_validate_intent_is_optional_a_semantic_port_omitting_it_is_undetected_by_getattr() -> None:
    class _NoValidate:
        async def normalize(self, input: object, ctx: SessionContext) -> IntentInput:
            return IntentInput(canonical="x.y", params={})

    assert getattr(_NoValidate(), "validate_intent", None) is None


def test_validate_intent_when_implemented_validates_and_returns_a_possibly_normalized_intent_input() -> None:
    class _WithValidate:
        async def validate_intent(self, intent: IntentInput, ctx: SessionContext) -> IntentInput:
            assert ctx is SESSION
            if intent.canonical != "sales.trend":
                raise IntentValidationError(f'unknown intent "{intent.canonical}"')
            # Fills in the schema default the caller omitted (mirrors a real IntentCatalogLike.validate_params).
            return IntentInput(canonical=intent.canonical, params={"metric": "revenue", **intent.params})

    port = _WithValidate()

    async def run() -> None:
        result = await port.validate_intent(IntentInput(canonical="sales.trend", params={}), SESSION)
        assert result == IntentInput(canonical="sales.trend", params={"metric": "revenue"})
        try:
            await port.validate_intent(IntentInput(canonical="sales.bogus", params={}), SESSION)
        except IntentValidationError:
            return
        raise AssertionError("expected IntentValidationError")

    asyncio.run(run())

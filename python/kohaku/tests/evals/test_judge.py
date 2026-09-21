"""Unit tests for LLM-as-Judge (the TS-side packages/evals/test/judge.test.ts as pytest).

Feeds scripted responses via FakeLlm and checks weighted combination / version stamping / prompt transcription /
fail-fast validation (does not call a real LLM).
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kohaku.evals import (
    ColumnMeta,
    Criterion,
    JudgeInput,
    JudgeSpecInput,
    JudgeSpecIntent,
    JudgeUsage,
    Rubric,
    Telemetry,
    create_judge,
    l1_quality_rubric,
    l2_promotion_rubric,
    l2_promotion_rubric_v0_1,
    l2_promotion_rubric_v0_2,
)
from kohaku.llm import FakeLlm
from kohaku.spec import UISpec, parse_spec

_COLUMNS = [
    ColumnMeta(name="region", type="string", description="Region"),
    ColumnMeta(name="revenue", type="number", description="Sales"),
]


def _uniform_verdict(rubric: Rubric, score: float, summary: str = "scoring") -> dict[str, Any]:
    """Build a judge response (conforming to JudgeOutput) that assigns a uniform score to each rubric criterion."""
    return {
        "criteria": [
            {"id": c.id, "score": score, "reasoning": f"{c.id}={score}"} for c in rubric.criteria
        ],
        "summary": summary,
    }


def _spec_input(spec: UISpec) -> JudgeSpecInput:
    return JudgeSpecInput(
        intent=JudgeSpecIntent(
            canonical="sales.quarterly_summary", params={"fiscalYear": 2026, "quarter": 3}
        ),
        spec=spec,
        columns=_COLUMNS,
    )


@pytest.fixture
def l1_spec(example_spec_data: dict[str, Any]) -> UISpec:
    return parse_spec(example_spec_data)


class TestJudgePromotion:
    def test_weighted_average_and_rubric_stamp(self) -> None:
        async def run() -> None:
            llm = FakeLlm(objects=[_uniform_verdict(l2_promotion_rubric, 0.8, "worthy of promotion")])
            judge = create_judge(llm=llm, pass_score=0.5)
            verdict = await judge.judge(
                JudgeInput(
                    html="<html><body><script>window.kohaku.ready()</script></body></html>",
                    request="as a heatmap",
                    usage=JudgeUsage(uses=3, sessions=2),
                )
            )
            # All criteria 0.8 and weight sum 1.0, so the combined score is also 0.8. safety's floor is
            # 0.5, and 0.8 clears it, so nothing is vetoed.
            assert verdict.score == 0.8
            assert verdict.pass_ is True
            assert verdict.vetoed_by == []
            assert verdict.rubric_id == "l2-promotion"
            assert verdict.rubric_version == "0.3"
            assert verdict.summary == "worthy of promotion"

        asyncio.run(run())

    def test_telemetry_transcribed_only_when_present(self) -> None:
        async def run() -> None:
            llm = FakeLlm(
                objects=[
                    _uniform_verdict(l2_promotion_rubric, 0.7),
                    _uniform_verdict(l2_promotion_rubric, 0.7),
                ]
            )
            judge = create_judge(llm=llm, pass_score=0.5)

            await judge.judge(
                JudgeInput(
                    html="<html></html>",
                    request="r",
                    usage=JudgeUsage(uses=5, sessions=3),
                    telemetry=Telemetry(rendered_count=4, error_count=1),
                )
            )
            with_telemetry = llm.calls[-1].prompt
            assert "Runtime telemetry" in with_telemetry
            assert "rendered=4, errors=1" in with_telemetry

            await judge.judge(
                JudgeInput(html="<html></html>", request="r", usage=JudgeUsage(uses=5, sessions=3))
            )
            assert "Runtime telemetry" not in llm.calls[-1].prompt

        asyncio.run(run())


class TestJudgeSpec:
    def test_l1_quality_scoring_and_prompt(self, l1_spec: UISpec) -> None:
        async def run() -> None:
            llm = FakeLlm(objects=[_uniform_verdict(l1_quality_rubric, 0.9, "good L1")])
            judge = create_judge(llm=llm, pass_score=0.6)
            verdict = await judge.judge_spec(_spec_input(l1_spec))

            assert verdict.score == 0.9
            assert verdict.pass_ is True
            assert verdict.rubric_id == "l1-quality"
            assert verdict.rubric_version == "0.1"

            prompt = llm.calls[-1].prompt
            assert "Spec under review (summary)" in prompt
            assert "sales.quarterly_summary" in prompt
            # The column meta is transcribed.
            assert "region: string" in prompt
            assert "revenue: number" in prompt
            # The component type appears in the Spec summary (components are folded).
            assert l1_spec.components[0].type in prompt

        asyncio.run(run())

    def test_separate_rubric_versions_do_not_mix(self, l1_spec: UISpec) -> None:
        async def run() -> None:
            llm = FakeLlm(
                objects=[
                    _uniform_verdict(l1_quality_rubric, 0.8),
                    _uniform_verdict(l2_promotion_rubric, 0.8),
                ]
            )
            judge = create_judge(llm=llm, pass_score=0.5)
            l1 = await judge.judge_spec(_spec_input(l1_spec))
            l2 = await judge.judge(
                JudgeInput(html="<html></html>", request="r", usage=JudgeUsage(uses=1, sessions=1))
            )
            assert l1.rubric_id == "l1-quality"
            assert l2.rubric_id == "l2-promotion"

        asyncio.run(run())


class TestJudgeAbnormal:
    def test_missing_criterion_falls_back_to_zero(self) -> None:
        async def run() -> None:
            # A response that omits safety (weight 0.25, floor 0.5) and returns the remaining 5 criteria
            # at full marks.
            llm = FakeLlm(
                objects=[
                    {
                        "criteria": [
                            {"id": c.id, "score": 1, "reasoning": f"{c.id}=1"}
                            for c in l2_promotion_rubric.criteria
                            if c.id != "safety"
                        ],
                        "summary": "safety not evaluated",
                    }
                ]
            )
            judge = create_judge(llm=llm, pass_score=0.5)
            verdict = await judge.judge(
                JudgeInput(html="<html></html>", request="r", usage=JudgeUsage(uses=1, sessions=1))
            )
            safety = next(c for c in verdict.criteria if c.id == "safety")
            assert safety.score == 0
            assert safety.reasoning == "(not evaluated)"
            # The missing criterion (weight 0.25) is combined at 0 points: the other 5 are full marks, so the weighted-average score = 1 - 0.25 = 0.75.
            assert verdict.score == 0.75
            # n-7: before the safety floor existed, 0.75 >= pass_score (0.5) alone made this a passing
            # verdict. safety's score (0) is strictly below its floor (0.5), so the verdict is now vetoed
            # and does NOT pass, even though the weighted-average score still clears pass_score.
            assert verdict.vetoed_by == ["safety"]
            assert verdict.pass_ is False

        asyncio.run(run())

    def test_unknown_criterion_ignored(self) -> None:
        async def run() -> None:
            llm = FakeLlm(
                objects=[
                    {
                        "criteria": [
                            *[
                                {"id": c.id, "score": 0.5, "reasoning": c.id}
                                for c in l2_promotion_rubric.criteria
                            ],
                            {"id": "unknown_extra", "score": 1, "reasoning": "mixed-in unknown criterion"},
                        ],
                        "summary": "has unknown criterion",
                    }
                ]
            )
            judge = create_judge(llm=llm, pass_score=0.5)
            verdict = await judge.judge(
                JudgeInput(html="<html></html>", request="r", usage=JudgeUsage(uses=1, sessions=1))
            )
            # Only the rubric's criteria are scored. The unknown id does not appear in verdict.criteria.
            assert [c.id for c in verdict.criteria] == [
                c.id for c in l2_promotion_rubric.criteria
            ]
            # All criteria 0.5, so the combination is also 0.5 (the unknown criterion's full mark 1.0 is ignored).
            assert verdict.score == 0.5
            # safety's own score (0.5) equals its floor (0.5) exactly — the floor only vetoes a score
            # strictly below it, so this is not a veto.
            assert verdict.vetoed_by == []
            assert verdict.pass_ is True

        asyncio.run(run())


class TestRubricValidation:
    _base = Rubric(id="custom", version="1", criteria=[Criterion(id="a", description="a", weight=1)])

    def _empty_llm(self) -> FakeLlm:
        return FakeLlm(objects=[])

    def test_rejects_negative_weight(self) -> None:
        with pytest.raises(ValueError, match="weight"):
            create_judge(
                llm=self._empty_llm(),
                spec_rubric=Rubric(
                    id="custom", version="1", criteria=[Criterion(id="a", description="a", weight=-1)]
                ),
            )

    def test_rejects_nan_and_infinity_weight(self) -> None:
        for bad in (float("nan"), float("inf")):
            with pytest.raises(ValueError, match="weight"):
                create_judge(
                    llm=self._empty_llm(),
                    rubric=Rubric(
                        id="custom",
                        version="1",
                        criteria=[Criterion(id="a", description="a", weight=bad)],
                    ),
                )

    def test_rejects_zero_weight_sum(self) -> None:
        with pytest.raises(ValueError, match="total weight"):
            create_judge(
                llm=self._empty_llm(),
                rubric=Rubric(
                    id="custom", version="1", criteria=[Criterion(id="a", description="a", weight=0)]
                ),
            )

    def test_rejects_duplicate_criteria_id(self) -> None:
        with pytest.raises(ValueError, match="duplicate"):
            create_judge(
                llm=self._empty_llm(),
                rubric=Rubric(
                    id="custom",
                    version="1",
                    criteria=[
                        Criterion(id="a", description="a", weight=0.5),
                        Criterion(id="a", description="a2", weight=0.5),
                    ],
                ),
            )

    def test_rejects_empty_criteria(self) -> None:
        with pytest.raises(ValueError, match="criteria"):
            create_judge(llm=self._empty_llm(), rubric=Rubric(id="custom", version="1", criteria=[]))

    def test_default_rubrics_pass_validation(self) -> None:
        create_judge(llm=self._empty_llm())  # must not raise


class TestScoreRoundingHalfUp:
    """D3a: rounding of the combined score is half-up (matching TS's Math.round(x*1000)/1000).

    Python's built-in round() uses banker's rounding, so it diverges from TS at boundary values.
    """

    def _judge_with_score(self, raw: float) -> float:
        async def run() -> float:
            custom = Rubric(
                id="c", version="1", criteria=[Criterion(id="a", description="a", weight=1.0)]
            )
            llm = FakeLlm(
                objects=[{"criteria": [{"id": "a", "score": raw, "reasoning": "a"}], "summary": "s"}]
            )
            judge = create_judge(llm=llm, rubric=custom, pass_score=0.5)
            verdict = await judge.judge(
                JudgeInput(html="<html></html>", request="r", usage=JudgeUsage(uses=1, sessions=1))
            )
            return verdict.score

        return asyncio.run(run())

    def test_half_up_at_even_boundary(self) -> None:
        # 0.5125*1000 = 512.5. half-up → 0.513 (banker's would fall to the even side 0.512).
        assert self._judge_with_score(0.5125) == 0.513

    def test_half_up_at_odd_boundary(self) -> None:
        # 0.4995*1000 = 499.5. half-up → 0.5 (banker's would be 0.499).
        assert self._judge_with_score(0.4995) == 0.5


class TestJsonStringifyEsNumbers:
    """D3b: _json_stringify formats numbers with ES Number::toString (matching JS's JSON.stringify)."""

    def test_integer_valued_float_has_no_trailing_zero(self) -> None:
        from kohaku.evals.judge import _json_stringify

        # json.dumps outputs "1.0"/"2026.0" but JS outputs "1"/"2026". Decimals pass through, and key order is kept even for exponents.
        assert _json_stringify({"a": 1.0, "b": 0.3, "c": [2.0, 3.5], "d": 2026.0}) == (
            '{"a":1,"b":0.3,"c":[2,3.5],"d":2026}'
        )
        # bool / None / integers are as before.
        assert _json_stringify({"t": True, "n": None, "i": 3}) == '{"t":true,"n":null,"i":3}'

    def test_judge_spec_prompt_formats_float_params_like_js(self, l1_spec: UISpec) -> None:
        """params containing an integer-valued float become "2026" (= JS) in the scoring prompt (the premise of FixtureLlm key matching)."""

        async def run() -> None:
            llm = FakeLlm(objects=[_uniform_verdict(l1_quality_rubric, 0.9)])
            judge = create_judge(llm=llm, pass_score=0.6)
            await judge.judge_spec(
                JudgeSpecInput(
                    intent=JudgeSpecIntent(
                        canonical="sales.quarterly_summary", params={"fiscalYear": 2026.0}
                    ),
                    spec=l1_spec,
                    columns=_COLUMNS,
                )
            )
            prompt = llm.calls[-1].prompt
            assert 'params={"fiscalYear":2026}' in prompt
            assert "2026.0" not in prompt

        asyncio.run(run())


class TestWeightNormalization:
    def test_custom_rubric_score_clamped_to_unit(self, l1_spec: UISpec) -> None:
        async def run() -> None:
            custom = Rubric(
                id="custom",
                version="9.9",
                criteria=[
                    Criterion(id="a", description="a", weight=1.0),
                    Criterion(id="b", description="b", weight=1.0),
                ],
            )
            llm = FakeLlm(
                objects=[
                    {
                        "criteria": [
                            {"id": "a", "score": 0.6, "reasoning": "a"},
                            {"id": "b", "score": 0.4, "reasoning": "b"},
                        ],
                        "summary": "s",
                    }
                ]
            )
            judge = create_judge(llm=llm, spec_rubric=custom, pass_score=0.5)
            verdict = await judge.judge_spec(_spec_input(l1_spec))
            # (0.6*1 + 0.4*1) / 2.0 = 0.5 (without normalization it would be 1.0, exceeding [0,1]).
            assert verdict.score == 0.5
            assert verdict.rubric_id == "custom"
            assert verdict.rubric_version == "9.9"

        asyncio.run(run())


class TestL2PromotionRubric:
    """l2_promotion_rubric (v0.3, current — pinned criteria id order, weights, and safety's floor;
    mirrors TS's l2PromotionRubric test, m-21/Task 8)."""

    def test_shape(self) -> None:
        assert l2_promotion_rubric.id == "l2-promotion"
        assert l2_promotion_rubric.version == "0.3"
        assert [c.id for c in l2_promotion_rubric.criteria] == [
            "safety",
            "determinism",
            "a11y",
            "schema_inferability",
            "generality",
            "visual_quality",
        ]
        weights = [c.weight for c in l2_promotion_rubric.criteria]
        assert weights == [0.25, 0.2, 0.15, 0.15, 0.05, 0.2]
        assert sum(weights) == pytest.approx(1.0)

    def test_only_safety_has_a_floor(self) -> None:
        assert [c.floor for c in l2_promotion_rubric.criteria] == [0.5, None, None, None, None, None]

    def test_visual_quality_description_covers_loading_fluid_width_and_countable_color_wording(
        self,
    ) -> None:
        visual_quality = next(c for c in l2_promotion_rubric.criteria if c.id == "visual_quality")
        # n-6: previously-unscored brief items now named explicitly.
        assert "loading" in visual_quality.description
        assert "never use fixed pixel widths — fill the container width" in visual_quality.description
        # n-8: "restrained color" (2 words, not scorable from markup) replaced by the L2 brief's own
        # countable wording (prompt.py's L2_SYSTEM_PROMPT design-brief bullet, verbatim).
        assert "restrained color" not in visual_quality.description
        assert (
            "use the primary color for one emphasis at most; tone colors only when they carry meaning"
            in visual_quality.description
        )


class TestL2PromotionRubricV0_1:
    """l2_promotion_rubric_v0_1 (pinned pre-visual_quality rubric; mirrors TS's l2PromotionRubricV0_1)."""

    def test_shape(self) -> None:
        assert l2_promotion_rubric_v0_1.id == "l2-promotion"
        assert l2_promotion_rubric_v0_1.version == "0.1"
        assert [c.id for c in l2_promotion_rubric_v0_1.criteria] == [
            "safety",
            "determinism",
            "a11y",
            "schema_inferability",
            "generality",
        ]
        weights = [c.weight for c in l2_promotion_rubric_v0_1.criteria]
        assert weights == [0.3, 0.2, 0.15, 0.2, 0.15]
        assert sum(weights) == pytest.approx(1.0)

    def test_pinned_via_judge_rubric_option(self) -> None:
        async def run() -> None:
            llm = FakeLlm(objects=[_uniform_verdict(l2_promotion_rubric_v0_1, 0.9)])
            judge = create_judge(llm=llm, pass_score=0.5, rubric=l2_promotion_rubric_v0_1)
            verdict = await judge.judge(
                JudgeInput(
                    html="<html><body><script>window.kohaku.ready()</script></body></html>",
                    request="as a table",
                    usage=JudgeUsage(uses=1, sessions=1),
                )
            )
            assert verdict.rubric_version == "0.1"
            assert [c.id for c in verdict.criteria] == [
                c.id for c in l2_promotion_rubric_v0_1.criteria
            ]

        asyncio.run(run())


class TestL2PromotionRubricV0_2:
    """l2_promotion_rubric_v0_2 (pinned pre-Task-8 rubric; mirrors TS's l2PromotionRubricV0_2)."""

    def test_shape(self) -> None:
        assert l2_promotion_rubric_v0_2.id == "l2-promotion"
        assert l2_promotion_rubric_v0_2.version == "0.2"
        assert [c.id for c in l2_promotion_rubric_v0_2.criteria] == [
            "safety",
            "determinism",
            "a11y",
            "schema_inferability",
            "generality",
            "visual_quality",
        ]
        weights = [c.weight for c in l2_promotion_rubric_v0_2.criteria]
        assert weights == [0.25, 0.2, 0.15, 0.15, 0.15, 0.1]
        assert sum(weights) == pytest.approx(1.0)
        assert [c.floor for c in l2_promotion_rubric_v0_2.criteria] == [None] * 6

    def test_pinned_via_judge_rubric_option_no_floor_veto_even_at_safety_zero(self) -> None:
        async def run() -> None:
            llm = FakeLlm(
                objects=[
                    {
                        "criteria": [
                            {
                                "id": c.id,
                                "score": 0 if c.id == "safety" else 1,
                                "reasoning": c.id,
                            }
                            for c in l2_promotion_rubric_v0_2.criteria
                        ],
                        "summary": "pinned v0.2, safety scored 0",
                    }
                ]
            )
            judge = create_judge(llm=llm, pass_score=0.5, rubric=l2_promotion_rubric_v0_2)
            verdict = await judge.judge(
                JudgeInput(
                    html="<html><body><script>window.kohaku.ready()</script></body></html>",
                    request="as a table",
                    usage=JudgeUsage(uses=1, sessions=1),
                )
            )
            assert verdict.rubric_version == "0.2"
            assert [c.id for c in verdict.criteria] == [
                c.id for c in l2_promotion_rubric_v0_2.criteria
            ]
            # Task 8's safety floor lives only on the current l2_promotion_rubric (v0.3), not on this
            # pinned pre-Task-8 snapshot — a consumer who pinned v0.2 keeps the exact pre-Task-8 behavior.
            assert verdict.vetoed_by == []
            assert verdict.pass_ is True

        asyncio.run(run())

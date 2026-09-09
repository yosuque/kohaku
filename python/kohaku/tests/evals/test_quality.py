"""Tests for the L1 quality-regression harness (the runQuality section of the TS-side judge.test.ts as pytest)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kohaku.evals import (
    ColumnMeta,
    JudgeSpecInput,
    JudgeSpecIntent,
    QualityCase,
    Rubric,
    create_judge,
    l1_quality_rubric,
    run_quality,
)
from kohaku.llm import FakeLlm
from kohaku.spec import UISpec, parse_spec

_COLUMNS = [
    ColumnMeta(name="region", type="string", description="Region"),
    ColumnMeta(name="revenue", type="number", description="Sales"),
]


def _uniform_verdict(rubric: Rubric, score: float, summary: str = "scoring") -> dict[str, Any]:
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


def test_min_score_gate_and_deterministic_report(l1_spec: UISpec) -> None:
    async def run() -> None:
        # Script judge_spec responses for 2 cases. The first is a high score, the second a low score.
        llm = FakeLlm(
            objects=[
                _uniform_verdict(l1_quality_rubric, 0.9),
                _uniform_verdict(l1_quality_rubric, 0.4),
            ]
        )
        judge = create_judge(llm=llm, pass_score=0.6)
        report = await run_quality(
            [
                QualityCase(name="high", input=_spec_input(l1_spec), min_score=0.8),
                QualityCase(name="low", input=_spec_input(l1_spec), min_score=0.8),
            ],
            judge,
        )
        assert report.pass_ is False
        assert report.cases[0].pass_ is True
        assert report.cases[0].score == 0.9
        assert report.cases[1].pass_ is False
        assert report.cases[1].score == 0.4
        # The version stamp remains in each case's verdict.
        assert report.cases[0].verdict.rubric_version == "0.1"

    asyncio.run(run())


def test_min_score_unset_uses_verdict_pass(l1_spec: UISpec) -> None:
    async def run() -> None:
        # pass_score 0.6. No min_score passed; the 1st is 0.7 (pass) / the 2nd is 0.5 (fail).
        llm = FakeLlm(
            objects=[
                _uniform_verdict(l1_quality_rubric, 0.7),
                _uniform_verdict(l1_quality_rubric, 0.5),
            ]
        )
        judge = create_judge(llm=llm, pass_score=0.6)
        report = await run_quality(
            [
                QualityCase(name="pass-by-verdict", input=_spec_input(l1_spec)),
                QualityCase(name="fail-by-verdict", input=_spec_input(l1_spec)),
            ],
            judge,
        )
        # No min_score → verdict.pass_ (score >= pass_score) becomes pass directly.
        assert report.cases[0].pass_ is True
        assert report.cases[0].pass_ == report.cases[0].verdict.pass_
        assert report.cases[1].pass_ is False
        assert report.cases[1].pass_ == report.cases[1].verdict.pass_
        assert report.pass_ is False
        # duration_ms is measured (out of scope for determinism) but is present as a numeric type.
        assert isinstance(report.cases[0].duration_ms, float)

    asyncio.run(run())

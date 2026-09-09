"""L1 Spec quality-regression harness (port of TS packages/evals/src/quality.ts; B7).

Runs alongside run_golden (whether the output Spec matches the expectation). Whereas run_golden checks
"identity (a variance-normalized match)", this regression-checks the L1 quality rubric score via
judge.judge_spec (whether it holds the "quality" lower bound). It can run deterministically with a judge
into which FakeLlm / FixtureLlm has been injected.

Positioning: this harness provides the mechanism up front (case → judge_spec → lower-bound gate → report).
Defining the actual quality cases and wiring FixtureLlm (record/replay) is the consumer's responsibility
(the product's regression suite); here we provide only the minimal, deterministically-running executor.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .judge import Judge, JudgeSpecInput, JudgeVerdict


@dataclass(frozen=True)
class QualityCase:
    name: str
    input: JudgeSpecInput
    min_score: float | None = None
    """The lower bound of the expected score. When given, verdict.score >= min_score is the pass condition
    (the regression threshold gate). When omitted, verdict.pass_ (based on the judge's pass_score) is used as-is."""


@dataclass(frozen=True)
class QualityCaseResult:
    name: str
    pass_: bool
    score: float
    verdict: JudgeVerdict
    duration_ms: float
    """The case's execution time (wall clock). Out of scope for determinism: pass_ / score / verdict are
    deterministic with FakeLlm/FixtureLlm injection, but duration_ms is a measured value that varies per run
    (not included in the regression comparison)."""


@dataclass(frozen=True)
class QualityReport:
    pass_: bool
    cases: list[QualityCaseResult]


async def run_quality(cases: list[QualityCase], judge: Judge) -> QualityReport:
    """Run the L1 quality cases through judge.judge_spec and regression-verify them."""
    results: list[QualityCaseResult] = []
    for c in cases:
        started_at = time.monotonic()
        verdict = await judge.judge_spec(c.input)
        passed = verdict.score >= c.min_score if c.min_score is not None else verdict.pass_
        results.append(
            QualityCaseResult(
                name=c.name,
                pass_=passed,
                score=verdict.score,
                verdict=verdict,
                duration_ms=(time.monotonic() - started_at) * 1000,
            )
        )
    return QualityReport(pass_=all(r.pass_ for r in results), cases=results)

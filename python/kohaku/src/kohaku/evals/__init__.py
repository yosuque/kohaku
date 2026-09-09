"""kohaku.evals — Golden Spec regression, LLM-as-Judge, quality regression, FixtureLlm (port of TS packages/evals).

Provides the same public surface as the TS reference implementation's index.ts.
"""

from .dataset import DistillationRecord, export_distillation_dataset
from .fixture_llm import FixtureLlm
from .golden import (
    GoldenCase,
    GoldenCaseResult,
    GoldenReport,
    MatchOptions,
    normalize_for_match,
    run_golden,
    specs_match,
)
from .judge import (
    ColumnMeta,
    Criterion,
    Judge,
    JudgeInput,
    JudgeSpecInput,
    JudgeSpecIntent,
    JudgeUsage,
    JudgeVerdict,
    Rubric,
    Telemetry,
    VerdictCriterion,
    create_judge,
    l1_quality_rubric,
    l2_promotion_rubric,
)
from .quality import (
    QualityCase,
    QualityCaseResult,
    QualityReport,
    run_quality,
)

__all__ = [
    "ColumnMeta",
    "Criterion",
    "DistillationRecord",
    "FixtureLlm",
    "GoldenCase",
    "GoldenCaseResult",
    "GoldenReport",
    "Judge",
    "JudgeInput",
    "JudgeSpecInput",
    "JudgeSpecIntent",
    "JudgeUsage",
    "JudgeVerdict",
    "MatchOptions",
    "QualityCase",
    "QualityCaseResult",
    "QualityReport",
    "Rubric",
    "Telemetry",
    "VerdictCriterion",
    "create_judge",
    "export_distillation_dataset",
    "l1_quality_rubric",
    "l2_promotion_rubric",
    "normalize_for_match",
    "run_golden",
    "run_quality",
    "specs_match",
]

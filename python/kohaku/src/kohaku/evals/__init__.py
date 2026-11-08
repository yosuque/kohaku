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
    l2_promotion_rubric_v0_1,
    l2_promotion_rubric_v0_2,
    l2_promotion_rubric_v0_3,
)
from .prompt_guard import untrusted_block
from .quality import (
    QualityCase,
    QualityCaseResult,
    QualityReport,
    run_quality,
)
from .schema_extraction import (
    SCHEMA_EXTRACTOR_ID,
    SCHEMA_EXTRACTOR_VERSION,
    ExamplesProvider,
    SchemaExtractionExample,
    SchemaExtractionInput,
    SchemaExtractionResult,
    SchemaExtractor,
    SchemaSuggestionOutput,
    create_schema_extractor,
    extract_data_refs,
)

__all__ = [
    "SCHEMA_EXTRACTOR_ID",
    "SCHEMA_EXTRACTOR_VERSION",
    "ColumnMeta",
    "Criterion",
    "DistillationRecord",
    "ExamplesProvider",
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
    "SchemaExtractionExample",
    "SchemaExtractionInput",
    "SchemaExtractionResult",
    "SchemaExtractor",
    "SchemaSuggestionOutput",
    "Telemetry",
    "VerdictCriterion",
    "create_judge",
    "create_schema_extractor",
    "export_distillation_dataset",
    "extract_data_refs",
    "l1_quality_rubric",
    "l2_promotion_rubric",
    "l2_promotion_rubric_v0_1",
    "l2_promotion_rubric_v0_2",
    "l2_promotion_rubric_v0_3",
    "normalize_for_match",
    "run_golden",
    "run_quality",
    "specs_match",
    "untrusted_block",
]

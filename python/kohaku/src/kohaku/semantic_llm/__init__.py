"""kohaku.semantic_llm -- the default SemanticPort (port of TS packages/semantic-llm).

`create_llm_semantic_port` maps a GUI action deterministically and an NL question via the LLM's structured
output onto an Intent catalog (reference passing only -- rows never enter the model's context), with
product-specific rules and a fallback Intent as options. It also owns the mutable `IntentCatalog`
(`create_intent_catalog`), with a `revision` counter for add / remove.

Depends on kohaku.spec + kohaku.intents + kohaku.llm only (TS: spec-core + data-binding + intents + llm;
`parse_query_ref` lives in kohaku.spec on the Python side).
"""

from .catalog import IntentCatalog, IntentCatalogLike, ParamsValidation, create_intent_catalog
from .filters import DEFAULT_MAX_FILTER_VARIANTS, vet_filters
from .gui import normalize_gui_action
from .nl import (
    DEFAULT_MAX_QUESTION_CHARS,
    NlNormalization,
    SemanticNormalizeError,
    normalize_nl_query,
)
from .port import (
    LlmSemanticPort,
    NormalizedInfo,
    UnknownIntentError,
    create_llm_semantic_port,
    default_output_locale,
)
from .prompt import (
    build_normalize_system_prompt,
    build_normalize_user_prompt,
    render_catalog_doc,
)

__all__ = [
    "DEFAULT_MAX_FILTER_VARIANTS",
    "DEFAULT_MAX_QUESTION_CHARS",
    "IntentCatalog",
    "IntentCatalogLike",
    "LlmSemanticPort",
    "NlNormalization",
    "NormalizedInfo",
    "ParamsValidation",
    "SemanticNormalizeError",
    "UnknownIntentError",
    "build_normalize_system_prompt",
    "build_normalize_user_prompt",
    "create_intent_catalog",
    "create_llm_semantic_port",
    "default_output_locale",
    "normalize_gui_action",
    "normalize_nl_query",
    "render_catalog_doc",
    "vet_filters",
]

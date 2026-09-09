"""kohaku.intents — Intent DSL (port of TS packages/intents).

An environment-neutral standalone leaf that depends only on spec-core + data-binding. From define_vocabulary
(the single source of a value set + labels) and define_intent (a single Intent definition), it derives the
SemanticPort IntentDef, the GUI facet descriptor (FacetView), the MCP tool input, and the client coerce.

In addition to the same public surface as the TS reference implementation's index.ts, it exposes the params
schema DSL (param_schema) that stands in for zod (TS imports zod externally, but in Python this package is the
definition site of the DSL).
"""

from .facet_view import FacetView, FacetViewEntry
from .intent import (
    DrilldownFn,
    DrilldownResult,
    FacetSpec,
    IntentDef,
    IntentDefinition,
    IntentSpec,
    IntentToolSource,
    QueriesFn,
    define_intent,
)
from .param_schema import (
    EnumField,
    NumberField,
    ObjectSchema,
    ParamError,
    ParamField,
    ParamParseResult,
    StringField,
    number,
    object_schema,
    string,
)
from .query_template import QueryTemplate, compile_query_template
from .value_type import enum_values_of, facet_value_type
from .vocabulary import Vocabulary, VocabularyEntry, define_vocabulary

__all__ = [
    "DrilldownFn",
    "DrilldownResult",
    "EnumField",
    "FacetSpec",
    "FacetView",
    "FacetViewEntry",
    "IntentDef",
    "IntentDefinition",
    "IntentSpec",
    "IntentToolSource",
    "NumberField",
    "ObjectSchema",
    "ParamError",
    "ParamField",
    "ParamParseResult",
    "QueriesFn",
    "QueryTemplate",
    "StringField",
    "Vocabulary",
    "VocabularyEntry",
    "compile_query_template",
    "define_intent",
    "define_vocabulary",
    "enum_values_of",
    "facet_value_type",
    "number",
    "object_schema",
    "string",
]

"""Mapping of promotion (L2->L1 publish) artifacts -> component / Intent (port of TS: apps/sample-api/src/intents/promoted.ts).

Promotion = entering governance. A promoted component is registered in the catalog as a sandbox-template implementation,
and a promoted Intent is added to the vocabulary of natural-language normalization.

This module holds pure transforms (promoted_component / promoted_intent) and coerce-schema construction. The per-tenant
registry (holding / rebuilding the projection) is promoted_registry.py; reconcile and the lineage / snapshot integration
are handled by app.py's wiring layer (create_promotions' on_publish / reconcile) (symmetric with TS: promoted-registry.ts / app.ts).

The param coerce uses the same mapping as TS (apps/sample-api/src/intents/promoted.ts's coerceBase): number/integer are
coerce number, boolean is an explicit mapping (equivalent to z.coerce.boolean), and other types or non-object nodes pass
through (equivalent to z.unknown()). boolean / unknown are not in the base DSL, so they are supplemented within this
module by subclassing ParamField (kohaku.intents remains unchanged).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from kohaku.data_binding import format_query_ref
from kohaku.intents import (
    EnumField,
    IntentDef,
    ObjectSchema,
    ParamError,
    ParamField,
    compile_query_template,
    number,
    object_schema,
    string,
)
from kohaku.intents import QueryTemplate as IntentQueryTemplate
from kohaku.lineage import ComponentDraft
from kohaku.registry import (
    CapabilityDecl,
    ComponentDefinition,
    FallbackDecl,
    ImplementationDecl,
    PropsSchema,
    define_component,
    props_schema_from_json_schema,
)
from kohaku.spec import JsonObject, QueryHandle, js_string

from .domain import DEMO_FISCAL_YEAR
from .intents_catalog import fiscal_year, region


@dataclass(frozen=True)
class PromotedEntry:
    """A promotion entry (an element of the projection held by the per-tenant registry).

    Persistence: the promotion-state snapshot (promotions.json) is the sole state authority, and this projection is
    rebuilt by startup reconcile (no independent persistence to promoted.json). reconcile is the responsibility of the
    host wiring layer.
    """

    artifactId: str
    draft: ComponentDraft
    html: str
    request: str | None = None
    publishedAt: str = ""


def promoted_component(entry: PromotedEntry) -> ComponentDefinition:
    """Turns a promoted component into a ComponentDefinition for catalog registration as a sandbox-template implementation."""
    # If draft.paramsJsonSchema exists, reconstruct propsSchema from it (a total transform, so it does not throw at startup).
    props_schema = (
        props_schema_from_json_schema(entry.draft.paramsJsonSchema)
        if entry.draft.paramsJsonSchema is not None
        else PropsSchema({"type": "object", "properties": {"title": {"type": "string"}}})
    )
    component_type = entry.draft.componentType

    def _fallback(_props: JsonObject) -> JsonObject:
        return {"markdown": f"({component_type} is not available on this surface)"}

    return define_component(
        ComponentDefinition(
            type=component_type,
            version=entry.draft.version,
            description=entry.draft.description,
            propsSchema=props_schema,
            capabilities=CapabilityDecl(events=[], data="required", children="none"),
            implementation=ImplementationDecl(kind="sandbox-template", html=entry.html),
            fallback=FallbackDecl(type="presentMarkdown", map_props=_fallback),
        )
    )


# Default Intent params for old promoted.json compatibility (without paramsJsonSchema / queryTemplate).
# The value ranges of fiscalYear / region reference the same source as catalog (intents_catalog).
DEFAULT_PROMOTED_PARAMS: ObjectSchema = object_schema(
    {"fiscalYear": fiscal_year.default(DEMO_FISCAL_YEAR), "region": region.enum().optional()}
)


def promoted_intent(entry: PromotedEntry) -> IntentDef:
    """Turns a promoted Intent into an IntentDef for SemanticPort."""
    draft = entry.draft
    # GUI facet input arrives as strings, so it is received with the coerce version. If paramsJsonSchema is not an object, the default params.
    params = _coerced_params_schema(draft.paramsJsonSchema) or DEFAULT_PROMOTED_PARAMS
    template = draft.queryTemplate

    def to_queries(p: JsonObject) -> list[QueryHandle]:
        if template is not None:
            # Unified with the same compile_query_template as core Intents (a single implementation of canonicalization / missing-value exclusion).
            # lineage's QueryTemplate is structurally identical to intents' QueryTemplate but a different type, so it is converted.
            intent_template = IntentQueryTemplate(
                path=template.path, paramMap=template.paramMap, fixedParams=template.fixedParams
            )
            return [compile_query_template("sales", intent_template, p)]
        # Old promoted.json compatibility: fixed trend logic.
        query_params = {"fy": js_string(p["fiscalYear"])}
        if p.get("region") is not None:
            query_params["region"] = js_string(p["region"])
        query_params["metric"] = "revenue"
        query_params["granularity"] = "month"
        return [QueryHandle(uri=format_query_ref(source="sales", path="trend", params=query_params))]

    return IntentDef(
        name=draft.intentName,
        description=draft.description,
        params=params,
        examples=[entry.request if entry.request is not None else draft.description],
        to_queries=to_queries,
    )


def _coerced_params_schema(schema: Any) -> ObjectSchema | None:
    """Builds a coerce schema for intent params from paramsJsonSchema (object).

    To allow GUI-origin string input, number/integer are received as coerce number. None if non-object or missing.
    """
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return None
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return None
    required_list = schema.get("required")
    required = (
        {k for k in required_list if isinstance(k, str)}
        if isinstance(required_list, list)
        else set()
    )
    shape: dict[str, ParamField] = {}
    for key, node in properties.items():
        base = _coerce_base(node)
        if isinstance(node, dict) and "default" in node:
            shape[key] = base.default(node["default"])
        else:
            shape[key] = base if key in required else base.optional()
    return object_schema(shape)


@dataclass(frozen=True)
class _BooleanField(ParamField):
    """Equivalent to z.coerce.boolean. Receives GUI-origin string input via an explicit mapping (query params are strings).

    Because z.coerce.boolean (= Boolean(input) semantics) turns "false"/"0" into true as non-empty strings, the TS side
    (promoted.ts) does an explicit mapping via z.preprocess. Matching that:
    a boolean passes through / "true"・"1" -> True / "false"・"0" -> False / anything else is a validation error.
    """

    def _coerce(self, value: Any) -> Any:
        if isinstance(value, bool):
            return value
        if value in ("true", "1"):
            return True
        if value in ("false", "0"):
            return False
        raise ParamError(f"not a boolean: {value!r}")


@dataclass(frozen=True)
class _UnknownField(ParamField):
    """Equivalent to z.unknown(). Passes through without coercing or validating (a catch-all for unsupported types / non-object nodes)."""

    def _coerce(self, value: Any) -> Any:
        return value


def _coerce_base(node: Any) -> ParamField:
    """Receives a flat primitive with a coerce-version field (the same mapping as TS's coerceBase)."""
    if not isinstance(node, dict):
        return _UnknownField()  # TS: if node is non-object, z.unknown()
    node_type = node.get("type")
    if node_type == "string":
        enum_values = node.get("enum")
        if (
            isinstance(enum_values, list)
            and len(enum_values) > 0
            and all(isinstance(x, str) for x in enum_values)
        ):
            return EnumField(values=tuple(enum_values))
        return string()
    if node_type == "number":
        return number()
    if node_type == "integer":
        return number(integer=True)
    if node_type == "boolean":
        return _BooleanField()
    # Unsupported types are equivalent to z.unknown() (pass through without coercing or validating).
    return _UnknownField()


__all__ = [
    "DEFAULT_PROMOTED_PARAMS",
    "PromotedEntry",
    "promoted_component",
    "promoted_intent",
]

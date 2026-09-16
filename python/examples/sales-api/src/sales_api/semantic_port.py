"""SemanticPort implementation (port of TS: apps/sample-api/src/ports/semantic-port.ts).

GUI actions are normalized deterministically without going through the LLM; natural language is mapped to the Intent
catalog by the LLM; both converge into the same IntentInput (= a CanonicalIntent before its hash is filled in) (the core of R5).

The fixed wording (rules) of the NL normalization prompt is kept character-identical to TS. However, the params-schema
JSON of each Intent is derived from Python's param DSL and its representation differs from zod's toJSONSchema
(an intentional difference; see _params_json below).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from kohaku.intents import (
    EnumField,
    NumberField,
    ObjectSchema,
    ParamField,
    StringField,
)
from kohaku.llm import GenerateObjectRequest, JsonSchema, LlmError, LlmPort
from kohaku.spec import (
    DataShape,
    GuiAction,
    Intent,
    IntentInput,
    JsonObject,
    NLQuery,
    QueryHandle,
    SemanticInput,
    SessionContext,
    parse_query_ref,
)

from .domain import SalesRepo, fiscal_year_of, quarter_of, shape_of
from .fixed_specs import language_of
from .intents_catalog import FISCAL_YEAR_MAX, FISCAL_YEAR_MIN, IntentCatalog


@dataclass(frozen=True)
class FiscalPeriod:
    fiscal_year: int
    quarter: int
    year: int
    """The calendar year (for the prompt's current-year/month notation. Distinct from the fiscal year)."""
    month: int


def fiscal_period_of(date: datetime) -> FiscalPeriod:
    """Runtime computation of the fiscal period, delegating the FY-label and quarter conventions to
    domain.py's fiscal_year_of/quarter_of (the single source, also used by TS's scripts/generate-seed.ts
    counterpart) so this real-clock reading and the seed's own fiscal calendar cannot drift apart.

    Used to derive the NL normalization prompt's "this period" / "this quarter" / "last year" from the current time
    rather than from a fixed string.

    Timezone note: `date.year`/`date.month` are read as given (whatever timezone `date` carries, naive or aware;
    the default caller passes `datetime.now()`, i.e. the server process's local time, not UTC). Around the April 1
    fiscal-year boundary (and, less critically, the other quarter boundaries), a request made in the last hours of
    March 31 or the first hours of April 1 local time can therefore land on either side of the boundary depending
    on the server's timezone, even though the underlying instant is the same. This only affects the NL-normalization
    prompt's "this period"/"this quarter" hint (not the seed data or any stored value), and the demo seed's fixed
    FY2025-FY2026 range is unaffected either way. Mirrors TS fiscalPeriodOf.
    """
    year = date.year
    month = date.month  # 1 to 12
    return FiscalPeriod(fiscal_year=fiscal_year_of(year, month), quarter=quarter_of(month), year=year, month=month)


def _clamp_fiscal_year(year: int) -> int:
    """Clamps the fiscal year to vocab's value range (FISCAL_YEAR_MIN to MAX) (TS: clampFiscalYear).

    The range is taken from intents_catalog (vocab's single source; fiscal_year's min/max = the seed's range).
    fiscal_period_of derives the fiscal year from the real clock, so it can return a year beyond the range the seed
    holds (FY2025 to FY2026) (e.g. April 2027 onward is FY2027). The seed is fixed-generated time-independently, so
    out-of-range fiscal years do not exist. We round here before injecting into the NL normalization prompt so the LLM
    is not made to choose a non-existent fiscal year (outside the fiscalYear enum). fiscal_period_of itself, as a pure
    fiscal-period computation, returns out-of-range values as-is.
    """
    return min(FISCAL_YEAR_MAX, max(FISCAL_YEAR_MIN, year))


class SalesSemanticPort:
    """Implementation of SemanticPort (a structural subtype). Constructed by create_semantic_port."""

    def __init__(
        self,
        *,
        repo: SalesRepo,
        catalog_for: Callable[[str | None], IntentCatalog],
        llm: LlmPort,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._repo = repo
        # Per-tenant Intent catalog resolution. Promoted Intents are per-tenant, so it returns base + promotions.
        self._catalog_for = catalog_for
        self._llm = llm
        # The source of the current time (resolving the NL normalization's "this period"). Default is the real clock; tests inject a fixed datetime.
        self._now = now if now is not None else datetime.now

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        # hash is not computed. The deterministic hash is filled in by the caller's (composer / host) finalize_intent.
        catalog = self._catalog_for(ctx.tenant)
        if isinstance(input, GuiAction):
            return _normalize_gui(input, catalog)
        return await _normalize_nl(input, catalog, self._llm, ctx, self._now)

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> list[QueryHandle]:
        def_ = self._catalog_for(tenant).get(intent.canonical)
        if def_ is None:
            raise ValueError(f"unknown intent: {intent.canonical}")
        return def_.to_queries(intent.params)

    async def data_version(self, handle: QueryHandle) -> str:
        # Common to all queries because there is a single domain.
        return self._repo.data_version()

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        ref = parse_query_ref(handle.uri)
        shape = shape_of(ref.path, ref.params)
        if shape is None:
            raise ValueError(f"unknown query path: {ref.path}")
        return shape


def create_semantic_port(
    *,
    repo: SalesRepo,
    catalog_for: Callable[[str | None], IntentCatalog],
    llm: LlmPort,
    now: Callable[[], datetime] | None = None,
) -> SalesSemanticPort:
    return SalesSemanticPort(repo=repo, catalog_for=catalog_for, llm=llm, now=now)


def _normalize_gui(input: GuiAction, catalog: IntentCatalog) -> IntentInput:
    """Deterministic normalization of GUI actions (does not pass through the LLM)."""
    # 1. View selection / facet change: specify the view via params.intent, merged with current.
    if input.action in ("view.select", "facet.change"):
        requested = input.params.get("intent")
        if requested is None and input.current is not None:
            requested = input.current.canonical
        if not isinstance(requested, str):
            raise ValueError("view.select requires params.intent")
        def_ = catalog.get(requested)
        if def_ is None:
            raise ValueError(f"unknown intent: {requested}")
        facets = {k: v for k, v in input.params.items() if k != "intent"}
        base: JsonObject = (
            dict(input.current.params)
            if input.current is not None and input.current.canonical == requested
            else {}
        )
        params = catalog.normalize_params(requested, {**base, **facets})
        if params is None:
            raise ValueError(f"invalid params for {requested}")
        return IntentInput(canonical=requested, params=params)

    # 2. Component events ("table1.rowClick", etc.): delegate to the Intent definition's drilldown.
    if "." in input.action and input.current is not None:
        current = input.current
        def_ = catalog.get(current.canonical)
        if def_ is not None and def_.drilldown is not None:
            nxt = def_.drilldown(current.params, input.params)
            canonical = nxt.canonical if nxt.canonical is not None else current.canonical
            params = catalog.normalize_params(canonical, nxt.params)
            if params is None:
                raise ValueError(f"drilldown produced invalid params for {canonical}")
            return IntentInput(canonical=canonical, params=params)
        # drilldown undefined: reflect only what can be merged from the payload into params.
        merged = catalog.normalize_params(current.canonical, {**current.params, **input.params})
        if merged is None:
            raise ValueError("event payload produced invalid params")
        return IntentInput(canonical=current.canonical, params=merged)

    raise ValueError(f"unsupported gui action: {input.action}")


async def _normalize_nl(
    input: NLQuery,
    catalog: IntentCatalog,
    llm: LlmPort,
    ctx: SessionContext,
    now: Callable[[], datetime],
) -> IntentInput:
    """Natural-language normalization (LLM).

    Falls back to sales.custom (L2 free generation) only when "the LLM responded normally but does not match a known Intent".
    Provider failures, cancellation, and misconfiguration are not degraded but thrown up to the caller (see the except below).
    """
    text = input.text
    # Locale hint precedence: the per-input NLQuery.locale wins over the session's, then the composer's own
    # output-language default (English; see language_of), rather than a second "ja" literal here. language_of
    # also normalizes any locale tag to its "ja"/"en" prompt hint (e.g. "ja-JP" -> "ja"), keeping this hint
    # consistent with how the rest of the app resolves output language for the same session.
    locale = language_of(input.locale if input.locale is not None else ctx.locale)
    names = catalog.names()
    # Output schema (intent enum + params record). Passed as JsonSchema (non-validating); validation is unified in normalize_params.
    output_schema = JsonSchema(
        {
            "type": "object",
            "properties": {
                "intent": {"type": "string", "enum": names},
                "params": {
                    "type": "object",
                    "additionalProperties": {"type": ["string", "number", "boolean"]},
                },
            },
            "required": ["intent", "params"],
            "additionalProperties": False,
        }
    )

    catalog_doc = "\n\n".join(
        f"### {def_.name}\n{def_.description}\n"
        f"params schema: {_params_json(def_.params)}\n"
        f"Examples: {' / '.join(def_.examples)}"
        for def_ in catalog.list_defs()
    )

    # "this period" / "this quarter" / "last year" are computed at runtime from the current time (an injectable clock) rather than fixed strings.
    period = fiscal_period_of(now())
    # Even if the real clock exceeds the seed range (FY2025 to FY2026), clamp to vocab's value range so a non-existent
    # fiscal year is not chosen (e.g. FY2027 at the time of 2027 -> FY2026). The previous year subtracts 1 from the
    # clamped current fiscal year and clamps again, also preventing under-run (FY2024, etc.). The quarter and calendar
    # year/month are informational display, so they are not rounded.
    current_fiscal_year = _clamp_fiscal_year(period.fiscal_year)
    prev_fiscal_year = _clamp_fiscal_year(current_fiscal_year - 1)

    system = "\n".join(
        [
            "You are the Intent normalizer for a business app. Map the user's question to exactly one Intent in the catalog below and",
            "extract its params. Rules:",
            f'- The fiscal year starts in April (FY{current_fiscal_year} = {current_fiscal_year}-04 to '
            f'{current_fiscal_year + 1}-03). "this period"/"this fiscal year" (今期/今年度) = fiscalYear={current_fiscal_year}; '
            f'"this quarter" (今四半期) = quarter={period.quarter} (now {period.year}-{period.month}).',
            f'- "last year"/"prior fiscal year" (前年/昨年度) = fiscalYear={prev_fiscal_year}',
            "- Normalize region names to japan / north_america / europe / apac (日本→japan, 北米→north_america, 欧州/ヨーロッパ→europe, アジア太平洋→apac)",
            "- For a visualization request that fits no Intent (a heatmap, matrix, or other bespoke form),"
            " choose sales.custom and put the original request text verbatim into params.request",
            "- Include only the keys present in the schema in params",
        ]
    )
    prompt = f"## Intent catalog\n\n{catalog_doc}\n\n## User question ({locale})\n{text}"

    try:
        result = await llm.generate_object(
            GenerateObjectRequest(
                schema=output_schema,
                schema_name="canonical_intent",
                system=system,
                prompt=prompt,
                temperature=0,
            )
        )
        obj: Any = result.object
        intent_name = obj.get("intent") if isinstance(obj, dict) else None
        raw_params = obj.get("params") if isinstance(obj, dict) else None
        if isinstance(intent_name, str) and isinstance(raw_params, dict):
            params = catalog.normalize_params(intent_name, raw_params)
            if params is not None:
                return IntentInput(canonical=intent_name, params=params)
        # A normal response that does not match a known Intent (the enum was chosen but params validation failed) -> to the custom fallback below.
    except LlmError as e:
        # The custom fallback is limited to INVALID_OUTPUT (there was a response but it does not match the schema).
        # ABORTED / PROVIDER / CONFIG are not even normal responses, so they are not swallowed but thrown up to the
        # caller (composer), surfacing as SEMANTIC_FAILED -> COMPOSE_FAILED.
        if e.code != "INVALID_OUTPUT":
            raise
    fallback = catalog.normalize_params("sales.custom", {"request": text})
    return IntentInput(
        canonical="sales.custom", params=fallback if fallback is not None else {"request": text}
    )


def _params_json(schema: ObjectSchema) -> str:
    """Converts an ObjectSchema to a JSON Schema string (for attaching to the prompt).

    Intentional difference: TS uses zod's toJSONSchema, but the Python version builds it naively from the param DSL.
    The generated bytes do not match TS, but they are not subject to prompt validation or caching (only the NL
    normalization LLM call). The fixed wording (rules / headings) is kept character-identical to TS.
    """
    return json.dumps(_object_json_schema(schema), separators=(",", ":"), ensure_ascii=False)


def _object_json_schema(schema: ObjectSchema) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for key, field in schema.shape.items():
        properties[key] = _field_json_schema(field)
        if not field.is_optional and not field.has_default:
            required.append(key)
    out: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        out["required"] = required
    return out


def _field_json_schema(field: ParamField) -> dict[str, Any]:
    node: dict[str, Any] = {}
    if isinstance(field, NumberField):
        node["type"] = "integer" if field.integer else "number"
        if field.minimum is not None:
            node["minimum"] = field.minimum
        if field.maximum is not None:
            node["maximum"] = field.maximum
    elif isinstance(field, EnumField):
        node["type"] = "string"
        node["enum"] = list(field.values)
    elif isinstance(field, StringField):
        node["type"] = "string"
        if field.min_length is not None:
            node["minLength"] = field.min_length
    if field.has_default:
        node["default"] = field.default_value
    return node


__all__ = ["FiscalPeriod", "SalesSemanticPort", "create_semantic_port", "fiscal_period_of"]

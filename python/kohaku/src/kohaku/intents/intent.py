"""The Intent builder that derives each consumer surface from a single definition (port of intent.ts; the core).

From one define_intent it derives the SemanticPort IntentDef (to_intent_def), the GUI facet descriptor
(to_facet_view), the MCP source (to_tool_source), and the coerce (parse_params).

Naming: since this is an in-process API that does not appear on the wire, method names follow the Python
convention of snake_case (same policy as ports.py: toQueries → to_queries, toIntentDef → to_intent_def, etc.).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from kohaku.spec import FilterDescriptor, FilterOption, JsonObject, QueryHandle

from .facet_view import FacetView, FacetViewEntry
from .param_schema import ObjectSchema, ParamField
from .query_template import QueryTemplate, compile_query_template
from .value_type import enum_values_of, facet_value_type
from .vocabulary import Vocabulary


@dataclass(frozen=True)
class DrilldownResult:
    """The return value of drilldown (equivalent to TS's `{ canonical?: string; params: JsonObject }`)."""

    params: JsonObject
    canonical: str | None = None


# Resolution of an Intent diff from a component event (rowClick, etc.).
DrilldownFn = Callable[[JsonObject, JsonObject], DrilldownResult]
# intent params → deterministic queries (reference-passing handles).
QueriesFn = Callable[[JsonObject], list[QueryHandle]]


class FiltersFn(Protocol):
    """(locale?) → the GUI filters the Intent exposes (see spec-level FilterDescriptor)."""

    def __call__(self, locale: str | None = None, /) -> list[FilterDescriptor]: ...


@dataclass(frozen=True)
class IntentDef:
    """(a) The SemanticPort IntentDef.

    Structurally identical to a product's hand-written IntentDef, and the source of normalization (GUI/NL) and
    resolve_query. This package holds it as the single definition site, and the product re-exports it.
    """

    name: str
    description: str
    params: ObjectSchema
    examples: list[str]
    """Example sentences to include in the NL normalization prompt."""
    to_queries: QueriesFn
    drilldown: DrilldownFn | None = None
    """None if unspecified (corresponds to `"drilldown" in def` being false in TS)."""
    filters: FiltersFn | None = None
    """The GUI filters this Intent exposes, derived from the `facets` declaration. Present only for a
    declarative-template Intent: a callback `queries` has no `paramMap` to read the query param name from.
    `locale` (a BCP-47-like tag such as "ja" or "ja-JP") selects the label overlays -- exact tag first, then its
    primary subtag -- falling back to the canonical label."""


@dataclass(frozen=True)
class IntentToolSource:
    """(c) The host-mcp-apps input (a structural type). An IntentDef is assignable, but this is provided as an explicit API."""

    name: str
    description: str
    params: ObjectSchema


@dataclass(frozen=True)
class FacetSpec:
    """A declaration of a param to expose as a GUI facet."""

    param: str
    """The params key (existence is checked when deriving to_facet_view)."""
    label: str
    """The canonical (English) display label (fiscal year, region, …)."""
    labels: dict[str, str] | None = None
    """Locale overlays for label (locale → label, e.g. {"ja": "地域"})."""
    order: int | None = None
    """Display order (explicit). When omitted, declaration order."""
    control: Literal["select", "radio", "number"] | None = None
    """The control kind. When omitted, "select"."""
    options: Vocabulary | list[dict[str, Any]] | None = None
    """The source of options:
    - Vocabulary → the value set and labels (incl. locale overlays) from a single source
    - {value,label,labels?}[] → a curated subset such as numeric ranges (3/5/10 for topN, etc.)
    - omitted + an enum param → automatically from that param's enum (labels reuse the value)
    """
    emptyLabel: str | None = None
    """The allowEmpty label (all regions, full year). Present ⇔ clearable."""
    emptyLabels: dict[str, str] | None = None
    """Locale overlays for emptyLabel. Meaningful only together with emptyLabel."""
    filterable: bool = True
    """Whether this facet may also become an injected L1 filter (`IntentDef.filters`, `ComposePolicy.l1Filters`).
    Declare False for a facet whose value changes the SHAPE of the result (its column names: a `metric` that
    renames the measure column, a `granularity` that renames the time column, a `groupBy` that renames the
    dimension column): an injected filter only swaps the bound query parameter, so the generated component's
    `x` / `y` / `columns` props would keep naming columns the new variant no longer returns. It still appears
    in `to_facet_view()` (the GUI facet, which re-composes the Intent) -- the flag only keeps it out of the
    in-place filters."""


@dataclass(frozen=True)
class IntentSpec:
    canonical: str
    description: str
    params: ObjectSchema
    examples: list[str]
    queries: list[QueryTemplate] | QueriesFn
    """A declarative template array (default) or an escape hatch (callback) for complex cases."""
    source: str | None = None
    """The query:// source (required on the template path; not needed on the callback path)."""
    viewLabel: str | None = None
    """The FacetView's view display label. When omitted, description."""
    viewLabels: dict[str, str] | None = None
    """Locale overlays for viewLabel (e.g. {"ja": "四半期サマリー"})."""
    facets: list[FacetSpec] | None = None
    """The subset of params exposed to the GUI. An omitted param is NL / drilldown only."""
    drilldown: DrilldownFn | None = None


class IntentDefinition:
    """The builder that derives each consumer surface from a single definition (its output is identical to TS's hand-written types = backward compatible)."""

    def __init__(self, spec: IntentSpec) -> None:
        self._spec = spec
        # to_queries is finalized at definition time (fail-fast rejects a missing source on the template path).
        self._to_queries: QueriesFn = _build_to_queries(spec)

    @property
    def canonical(self) -> str:
        return self._spec.canonical

    def to_intent_def(self) -> IntentDef:
        """(a) The SemanticPort IntentDef."""
        spec = self._spec
        return IntentDef(
            name=spec.canonical,
            description=spec.description,
            params=spec.params,
            examples=spec.examples,
            to_queries=self._to_queries,
            drilldown=spec.drilldown,
            filters=_build_filters(spec),
        )

    def to_facet_view(self) -> FacetView:
        """(b) The framework-neutral GUI facet descriptor."""
        return _build_facet_view(self._spec)

    def to_tool_source(self) -> IntentToolSource:
        """(c) The host-mcp-apps intent tool input."""
        spec = self._spec
        return IntentToolSource(
            name=spec.canonical, description=spec.description, params=spec.params
        )

    def parse_params(self, raw: Mapping[str, str]) -> JsonObject:
        """(d) Centralized coerce (= params.parse. Fills defaults)."""
        return self._spec.params.parse(raw)


def define_intent(spec: IntentSpec) -> IntentDefinition:
    return IntentDefinition(spec)


def _build_to_queries(spec: IntentSpec) -> QueriesFn:
    queries = spec.queries
    if callable(queries):
        return queries
    source = spec.source
    if source is None:
        raise ValueError(
            f'Intent "{spec.canonical}" declares queries as templates but source is unspecified'
        )
    source_str: str = source
    templates = queries

    def run(p: JsonObject) -> list[QueryHandle]:
        return [compile_query_template(source_str, template, p) for template in templates]

    return run


def _build_filters(spec: IntentSpec) -> FiltersFn | None:
    """Derive IntentDef.filters from the facet declarations (port of intent.ts's buildFilters).

    Uses the same resolution as to_facet_view, so the two never disagree. A facet becomes a filter when it is
    a discrete string-valued select: `control` is "select" (the default), the param is not numeric (a numeric
    facet is a range/curation, not an enumeration), and it has at least one option. The query param comes from
    the templates' `paramMap`; a param mapped to different query params by different templates is ambiguous
    and is skipped, as is a param no template maps. `paths` are the template paths that map the param.

    A filter is excluded entirely when its `queryParam` would not have one meaning across the Intent's refs
    (FilterDescriptor's contract): it is also a `fixedParams` key of any template (the ref's value is fixed,
    not the param's), or another Intent param maps to the same query parameter on one of the filter's paths.
    A facet declared `filterable=False` (one that changes the result's column names) is never a filter.
    None for a callback `queries`.
    """
    queries = spec.queries
    if callable(queries):
        return None
    templates = queries
    entries: list[tuple[FacetViewEntry, str, list[str]]] = []
    not_filterable = {f.param for f in (spec.facets or []) if not f.filterable}
    for entry in _build_facet_view(spec).facets:
        if entry.key in not_filterable:
            continue
        if entry.control != "select" or entry.valueType != "string" or len(entry.options) == 0:
            continue
        mapped: list[str] = []
        paths: list[str] = []
        for template in templates:
            query_param = (template.paramMap or {}).get(entry.key)
            if query_param is None:
                continue
            if query_param not in mapped:
                mapped.append(query_param)
            if template.path not in paths:
                paths.append(template.path)
        if len(mapped) != 1:
            continue
        query_param = mapped[0]
        if any(query_param in (t.fixedParams or {}) for t in templates):
            continue
        shared = any(
            t.path in paths
            and any(
                qp == query_param and param != entry.key for param, qp in (t.paramMap or {}).items()
            )
            for t in templates
        )
        if shared:
            continue
        entries.append((entry, query_param, paths))

    def filters(locale: str | None = None, /) -> list[FilterDescriptor]:
        return [
            FilterDescriptor(
                param=entry.key,
                queryParam=query_param,
                paths=list(paths),
                label=_localized(entry.labels, locale, entry.label),
                options=[
                    FilterOption(
                        value=opt["value"],
                        label=_localized(opt.get("labels"), locale, opt["label"]),
                    )
                    for opt in entry.options
                ],
            )
            for entry, query_param, paths in entries
        ]

    return filters


def _localized(labels: dict[str, str] | None, locale: str | None, canonical: str) -> str:
    """The locale overlay for `locale` (exact tag, then its primary subtag: "ja-JP" -> "ja"), else the canonical label."""
    if locale is None or labels is None:
        return canonical
    if locale in labels:
        return labels[locale]
    return labels.get(locale.split("-")[0], canonical)


def _build_facet_view(spec: IntentSpec) -> FacetView:
    shape = spec.params.shape
    facets = spec.facets or []
    # Stable-sort by explicit order when present, otherwise by declaration order (index).
    indexed = [
        (facet, facet.order if facet.order is not None else index)
        for index, facet in enumerate(facets)
    ]
    indexed.sort(key=lambda pair: pair[1])
    entries: list[FacetViewEntry] = []
    for facet, _sort_key in indexed:
        field = shape.get(facet.param)
        if field is None:
            raise ValueError(
                f'Facet param "{facet.param}" of intent "{spec.canonical}" does not exist in params'
            )
        entries.append(
            FacetViewEntry(
                key=facet.param,
                label=facet.label,
                labels=dict(facet.labels) if facet.labels is not None else None,
                control=facet.control if facet.control is not None else "select",
                valueType=facet_value_type(field),
                options=_resolve_facet_options(spec, facet, field),
                allowEmpty=facet.emptyLabel,
                allowEmptyLabels=(
                    dict(facet.emptyLabels)
                    if facet.emptyLabel is not None and facet.emptyLabels is not None
                    else None
                ),
            )
        )
    return FacetView(
        intent=spec.canonical,
        label=spec.viewLabel if spec.viewLabel is not None else spec.description,
        labels=dict(spec.viewLabels) if spec.viewLabels is not None else None,
        facets=entries,
    )


def _resolve_facet_options(
    spec: IntentSpec, facet: FacetSpec, field: ParamField
) -> list[dict[str, Any]]:
    options = facet.options
    if options is None:
        # When omitted, derive from the param's enum (labels reuse the value). Error if it is not an enum.
        values = enum_values_of(field)
        if values is None:
            raise ValueError(
                f'Facet "{facet.param}" of intent "{spec.canonical}" '
                "must be an enum param when options is omitted"
            )
        return [{"value": value, "label": value} for value in values]
    if isinstance(options, Vocabulary):
        return options.options()
    out: list[dict[str, Any]] = []
    for opt in options:
        entry: dict[str, Any] = {"value": opt["value"], "label": opt["label"]}
        if opt.get("labels") is not None:
            entry["labels"] = dict(opt["labels"])
        out.append(entry)
    return out

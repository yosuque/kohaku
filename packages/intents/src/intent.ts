import type { FilterDescriptor, JsonObject, QueryHandle } from "@kohaku-ui/spec-core";
import type { z } from "zod";
import type { FacetView, FacetViewEntry } from "./facet-view.js";
import { compileQueryTemplate, type QueryTemplate } from "./query-template.js";
import { enumValuesOf, facetValueType } from "./value-type.js";
import type { Vocabulary } from "./vocabulary.js";

/**
 * (a) IntentDef for SemanticPort. Structurally identical to a product's hand-written IntentDef;
 * it is the source for normalization (GUI/NL) and resolveQuery. This package holds it as the single
 * definition site and the product re-exports it.
 */
export interface IntentDef {
  name: string;
  description: string;
  params: z.ZodObject;
  /** Example sentences to include in the NL normalization prompt. */
  examples: string[];
  toQueries(params: JsonObject): QueryHandle[];
  /** Resolves the Intent delta from a component event (rowClick, etc.). */
  drilldown?: (current: JsonObject, payload: JsonObject) => { canonical?: string; params: JsonObject };
  /**
   * The GUI filters this Intent exposes (see spec-core's `FilterDescriptor`), derived from the `facets`
   * declaration. Present only for a declarative-template Intent: a callback `queries` has no `paramMap` to
   * read the query param name from. `locale` (a BCP-47-like tag such as "ja" or "ja-JP") selects the label
   * overlays -- exact tag first, then its primary subtag -- falling back to the canonical label.
   */
  filters?: (locale?: string) => FilterDescriptor[];
}

/** (c) host-mcp-apps input (structural type). IntentDef is assignable to it, but this is provided as an explicit API. */
export interface IntentToolSource {
  name: string;
  description: string;
  params: z.ZodObject;
}

/** Declaration of a param exposed as a GUI facet. */
export interface FacetSpec {
  /** Key in params (existence is checked when deriving toFacetView). */
  param: string;
  /** Canonical (English) display label (fiscal year, region, ...). */
  label: string;
  /** Locale overlays for label (locale → label, e.g. { ja: "地域" }). */
  labels?: Record<string, string>;
  /** Display order (explicit). Falls back to declaration order when omitted. */
  order?: number;
  /** Control kind. Defaults to "select" when omitted. */
  control?: "select" | "radio" | "number";
  /**
   * Source of options:
   * - Vocabulary → value set and labels (incl. locale overlays) from a single source
   * - {value,label,labels?}[] → a curated subset such as a numeric range (topN of 3/5/10, etc.)
   * - omitted + enum param → automatically from that param's enum (label reuses value)
   */
  options?: Vocabulary | { value: string; label: string; labels?: Record<string, string> }[];
  /** allowEmpty text (e.g. All regions, Full year). Present ⇔ clearable. */
  emptyLabel?: string;
  /** Locale overlays for emptyLabel. Meaningful only together with emptyLabel. */
  emptyLabels?: Record<string, string>;
  /**
   * Whether this facet may also become an injected L1 filter (`IntentDef.filters`, `ComposePolicy.l1Filters`).
   * Default true. Declare `false` for a facet whose value changes the SHAPE of the result (its column names:
   * a `metric` that renames the measure column, a `granularity` that renames the time column, a `groupBy`
   * that renames the dimension column): an injected filter only swaps the bound query parameter, so the
   * generated component's `x` / `y` / `columns` props would keep naming columns the new variant no longer
   * returns. It still appears in `toFacetView()` (the GUI facet, which re-composes the Intent) -- the flag
   * only keeps it out of the in-place filters.
   */
  filterable?: boolean;
}

export interface IntentSpec {
  canonical: string;
  description: string;
  params: z.ZodObject;
  examples: string[];
  /** Source for query:// (required on the template path; not needed on the callback path). */
  source?: string;
  /** View display label for FacetView. Falls back to description when omitted. */
  viewLabel?: string;
  /** Locale overlays for viewLabel (locale → label, e.g. { ja: "四半期サマリー" }). */
  viewLabels?: Record<string, string>;
  /** Subset of params exposed to the GUI. Params omitted here are NL / drilldown only (e.g. sales.trend's productId). */
  facets?: FacetSpec[];
  /** Declarative template array (default) or an escape hatch (callback) for complex cases. */
  queries: QueryTemplate[] | ((p: JsonObject) => QueryHandle[]);
  drilldown?: (current: JsonObject, payload: JsonObject) => { canonical?: string; params: JsonObject };
}

/** Builder that derives each consumption surface from a single definition (output is identical to the current hand-written types = backward compatible). */
export interface IntentBuilder {
  readonly canonical: string;
  /** (a) IntentDef for SemanticPort. */
  toIntentDef(): IntentDef;
  /** (b) Framework-agnostic GUI facet descriptor. */
  toFacetView(): FacetView;
  /** (c) host-mcp-apps intent tool input. */
  toToolSource(): IntentToolSource;
  /** (d) Unified coerce (= params.parse; fills defaults). */
  parseParams(raw: Record<string, string>): JsonObject;
}

export function defineIntent(spec: IntentSpec): IntentBuilder {
  // Fix toQueries at declaration time (fail-fast rejection of an unspecified source on the template path).
  const toQueries = buildToQueries(spec);
  return {
    canonical: spec.canonical,
    toIntentDef() {
      const def: IntentDef = {
        name: spec.canonical,
        description: spec.description,
        params: spec.params,
        examples: spec.examples,
        toQueries,
      };
      if (spec.drilldown != null) def.drilldown = spec.drilldown;
      const filters = buildFilters(spec);
      if (filters != null) def.filters = filters;
      return def;
    },
    toFacetView: () => buildFacetView(spec),
    toToolSource: () => ({ name: spec.canonical, description: spec.description, params: spec.params }),
    parseParams: (raw) => spec.params.parse(raw) as JsonObject,
  };
}

function buildToQueries(spec: IntentSpec): (p: JsonObject) => QueryHandle[] {
  const queries = spec.queries;
  if (typeof queries === "function") return queries;
  const source = spec.source;
  if (source == null) {
    throw new Error(`Intent "${spec.canonical}" declares queries as templates but source is unspecified`);
  }
  return (p) => queries.map((template) => compileQueryTemplate(source, template, p));
}

/**
 * Derives IntentDef.filters from the facet declarations (the same resolution toFacetView uses, so the two
 * never disagree). A facet becomes a filter when it is a discrete string-valued select: `control` is "select"
 * (the default), the param is not numeric (a numeric facet is a range/curation, not an enumeration), and it
 * has at least one option. The query param comes from the templates' `paramMap`; a param mapped to different
 * query params by different templates is ambiguous and is skipped, as is a param no template maps.
 * `paths` are the template paths that map the param.
 *
 * A filter is excluded entirely when its `queryParam` would not have one meaning across the Intent's refs
 * (FilterDescriptor's contract): it is also a `fixedParams` key of any template (the ref's value is fixed, not
 * the param's), or another Intent param maps to the same query parameter on one of the filter's paths.
 * A facet declared `filterable: false` (one that changes the result's column names) is never a filter.
 * undefined for a callback `queries` (nothing to read a `paramMap` from).
 */
function buildFilters(spec: IntentSpec): IntentDef["filters"] | undefined {
  const queries = spec.queries;
  if (typeof queries === "function") return undefined;
  const entries: { entry: FacetViewEntry; queryParam: string; paths: string[] }[] = [];
  const notFilterable = new Set(
    (spec.facets ?? []).filter((f) => f.filterable === false).map((f) => f.param),
  );
  for (const entry of buildFacetView(spec).facets) {
    if (notFilterable.has(entry.key)) continue;
    if (entry.control !== "select" || entry.valueType !== "string" || entry.options.length === 0) continue;
    const mapped = new Set<string>();
    const paths: string[] = [];
    for (const template of queries) {
      const queryParam = template.paramMap?.[entry.key];
      if (queryParam == null) continue;
      mapped.add(queryParam);
      if (!paths.includes(template.path)) paths.push(template.path);
    }
    if (mapped.size !== 1) continue;
    const queryParam = [...mapped][0]!;
    if (queries.some((t) => t.fixedParams != null && Object.hasOwn(t.fixedParams, queryParam))) continue;
    const shared = queries.some(
      (t) =>
        paths.includes(t.path) &&
        Object.entries(t.paramMap ?? {}).some(([param, qp]) => qp === queryParam && param !== entry.key),
    );
    if (shared) continue;
    entries.push({ entry, queryParam, paths });
  }
  return (locale) =>
    entries.map(({ entry, queryParam, paths }) => ({
      param: entry.key,
      queryParam,
      paths: [...paths],
      label: localized(entry.labels, locale, entry.label),
      options: entry.options.map((opt) => ({
        value: opt.value,
        label: localized(opt.labels, locale, opt.label),
      })),
    }));
}

/** The locale overlay for `locale` (exact tag, then its primary subtag: "ja-JP" -> "ja"), else the canonical label. */
function localized(
  labels: Record<string, string> | undefined,
  locale: string | undefined,
  canonical: string,
): string {
  if (locale == null || labels == null) return canonical;
  return labels[locale] ?? labels[locale.split("-")[0]!] ?? canonical;
}

function buildFacetView(spec: IntentSpec): FacetView {
  const shape = spec.params.shape as Record<string, z.ZodType>;
  const facets = spec.facets ?? [];
  // Stable-sort by explicit order when present, otherwise by declaration order (index).
  const entries = facets
    .map((facet, index) => ({ facet, sortKey: facet.order ?? index }))
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ facet }): FacetViewEntry => {
      const field = shape[facet.param];
      if (field == null) {
        throw new Error(
          `Facet param "${facet.param}" of intent "${spec.canonical}" does not exist in params`,
        );
      }
      const entry: FacetViewEntry = {
        key: facet.param,
        label: facet.label,
        control: facet.control ?? "select",
        valueType: facetValueType(field),
        options: resolveFacetOptions(spec, facet, field),
      };
      if (facet.labels != null) entry.labels = { ...facet.labels };
      if (facet.emptyLabel != null) {
        entry.allowEmpty = facet.emptyLabel;
        if (facet.emptyLabels != null) entry.allowEmptyLabels = { ...facet.emptyLabels };
      }
      return entry;
    });
  const view: FacetView = {
    intent: spec.canonical,
    label: spec.viewLabel ?? spec.description,
    facets: entries,
  };
  if (spec.viewLabels != null) view.labels = { ...spec.viewLabels };
  return view;
}

function resolveFacetOptions(
  spec: IntentSpec,
  facet: FacetSpec,
  field: z.ZodType,
): { value: string; label: string; labels?: Record<string, string> }[] {
  const options = facet.options;
  if (options == null) {
    // When omitted, derive from the param's enum (label reuses value). Error if it is not an enum.
    const values = enumValuesOf(field);
    if (values == null) {
      throw new Error(
        `Facet "${facet.param}" of intent "${spec.canonical}" must be an enum param when options is omitted`,
      );
    }
    return values.map((value) => ({ value, label: value }));
  }
  if (isVocabulary(options)) return options.options();
  return options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    ...(opt.labels != null ? { labels: { ...opt.labels } } : {}),
  }));
}

function isVocabulary(
  options: Vocabulary | { value: string; label: string; labels?: Record<string, string> }[],
): options is Vocabulary {
  return !Array.isArray(options) && typeof (options as Vocabulary).options === "function";
}

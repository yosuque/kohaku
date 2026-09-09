import type { JsonObject, QueryHandle } from "@kohaku-ui/spec-core";
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

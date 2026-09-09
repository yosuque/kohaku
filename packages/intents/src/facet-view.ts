/**
 * GUI facet descriptor (framework-agnostic JSON). Consumed by sample-web's FacetPanel.
 * Derived from defineIntent's facets declaration + params (Zod), and emitted to facet-views.json by codegen.
 * `label` fields are canonical (English); the optional `labels` maps carry locale overlays
 * (locale → label, e.g. { ja: "地域" }) and are emitted only when declared.
 */
export interface FacetView {
  intent: string;
  label: string;
  labels?: Record<string, string>;
  facets: FacetViewEntry[];
}

export interface FacetViewEntry {
  key: string;
  label: string;
  labels?: Record<string, string>;
  control: "select" | "radio" | "number";
  /** Derived from Zod's coerce. The single source for client coerce (whether "2026"→2026). */
  valueType: "number" | "string";
  options: { value: string; label: string; labels?: Record<string, string> }[];
  /** emptyLabel. Present ⇔ clearable (e.g. All regions, Full year). */
  allowEmpty?: string;
  /** Locale overlays for allowEmpty. Present only when allowEmpty is. */
  allowEmptyLabels?: Record<string, string>;
}

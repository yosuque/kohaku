import type { SchemaSuggestionView } from "@kohaku-ui/client";
import type { DraftForm } from "./draft.js";

export type SuggestionField = keyof DraftForm;

export interface SuggestionFieldDiff {
  field: SuggestionField;
  suggested: string;
  current: string;
  changed: boolean;
}

/** The form's field order, which is also the diff's display order. */
const FIELDS: readonly SuggestionField[] = [
  "componentType",
  "version",
  "intentName",
  "description",
  "paramsJsonSchema",
  "queryPath",
  "fixedParams",
  "paramMap",
];

const JSON_FIELDS: ReadonlySet<SuggestionField> = new Set(["paramsJsonSchema", "fixedParams", "paramMap"]);

function jsonText(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

/**
 * Prefill: the machine-extracted draft (`PromotionCandidateView.suggestion`) rendered into the same text fields
 * the reviewer edits by hand. PromotionsTab prefers this over `PromotionDefaults.initialDraftFor` when a
 * candidate carries a suggestion (unless `preferSuggestion: false`).
 */
export function draftFormFromSuggestion(suggestion: SchemaSuggestionView): DraftForm {
  const { draft } = suggestion;
  return {
    componentType: draft.componentType,
    version: draft.version,
    intentName: draft.intentName,
    description: draft.description,
    paramsJsonSchema: jsonText(draft.paramsJsonSchema),
    queryPath: draft.queryTemplate?.path ?? "",
    fixedParams: jsonText(draft.queryTemplate?.fixedParams),
    paramMap: jsonText(draft.queryTemplate?.paramMap),
  };
}

/** Canonical form of a text field for comparison: JSON fields compare by sorted-key JSON, others by trimmed text. Invalid JSON never equals anything. */
function normalize(field: SuggestionField, text: string): string | null {
  if (!JSON_FIELDS.has(field)) return text.trim();
  if (text.trim() === "") return "";
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    return null;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Field-level diff of the current form against the suggestion (the UI's "what did I change" view). */
export function diffAgainstSuggestion(
  form: DraftForm,
  suggestion: SchemaSuggestionView,
): SuggestionFieldDiff[] {
  const base = draftFormFromSuggestion(suggestion);
  return FIELDS.map((field) => {
    const suggested = base[field];
    const current = form[field];
    const a = normalize(field, suggested);
    const b = normalize(field, current);
    return { field, suggested, current, changed: a == null || b == null || a !== b };
  });
}

export function hasEdits(diff: SuggestionFieldDiff[]): boolean {
  return diff.some((d) => d.changed);
}

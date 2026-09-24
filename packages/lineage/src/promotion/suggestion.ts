import { canonicalStringify } from "@kohaku-ui/spec-core";
import type { ComponentDraft } from "./machine.js";

/**
 * A machine-extracted registration proposal for a promotion candidate (advisory only). Produced by a
 * `suggestSchema` hook (the product wires `@kohaku-ui/evals`' extractor there), persisted on the promotion
 * snapshot (`data.suggestion`) so the approval UI can prefill its form, and never applied without a human
 * `approve` carrying the final draft (LIN-PRM-001 is untouched: the suggestion is not a transition).
 * Re-exported from spec-core (not defined here): it is a wire-contract type shared by `evals` (which
 * produces it) and `client` (which mirrors it as a REST view), and those packages are lineage's siblings
 * (no back-flow allowed), so the single definition lives one layer down instead of being hand-duplicated
 * three times.
 */
export type { SchemaSuggestion, SuggestedEvent } from "@kohaku-ui/spec-core";

export type DraftDiffField =
  | "componentType"
  | "version"
  | "intentName"
  | "description"
  | "paramsJsonSchema"
  | "queryTemplate";

const DRAFT_DIFF_FIELDS: readonly DraftDiffField[] = [
  "componentType",
  "version",
  "intentName",
  "description",
  "paramsJsonSchema",
  "queryTemplate",
];

export interface DraftFieldChange {
  field: DraftDiffField;
  suggested: unknown;
  final: unknown;
}

export interface DraftDiff {
  changed: DraftFieldChange[];
  unchanged: DraftDiffField[];
}

/** Canonical JSON of a draft field; an absent optional field compares as the empty string. */
function fieldKey(value: unknown): string {
  return value === undefined ? "" : canonicalStringify(value);
}

/**
 * Field-level diff between the extractor's suggested draft and the draft the reviewer finally submitted.
 * Pure. Object fields (paramsJsonSchema / queryTemplate) are compared by canonical JSON, so a reviewer who
 * only re-ordered keys did not "edit" the field. The output is what `component.schemaEdited` records and what
 * few-shot mining reads later, so the field order is fixed (DRAFT_DIFF_FIELDS) rather than insertion order.
 */
export function diffDraft(suggested: ComponentDraft, final: ComponentDraft): DraftDiff {
  const changed: DraftFieldChange[] = [];
  const unchanged: DraftDiffField[] = [];
  for (const field of DRAFT_DIFF_FIELDS) {
    if (fieldKey(suggested[field]) === fieldKey(final[field])) unchanged.push(field);
    else changed.push({ field, suggested: suggested[field], final: final[field] });
  }
  return { changed, unchanged };
}

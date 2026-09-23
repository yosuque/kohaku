import { canonicalStringify } from "@kohaku-ui/spec-core";
import type { ComponentDraft } from "./machine.js";

/** One event the extractor believes the component emits through window.kohaku.emit. */
export interface SuggestedEvent {
  name: string;
  description: string;
}

/**
 * A machine-extracted registration proposal for a promotion candidate (advisory only). Produced by a
 * `suggestSchema` hook (the product wires `@kohaku-ui/evals`' extractor there), persisted on the promotion
 * snapshot (`data.suggestion`) so the approval UI can prefill its form, and never applied without a human
 * `approve` carrying the final draft (LIN-PRM-001 is untouched: the suggestion is not a transition).
 * The type lives here, not in evals, because lineage owns `PromotionCandidate` and must not depend on the LLM
 * layer — evals returns a structurally identical object (the same idiom as host-rest's `ComponentDraftSchema`).
 */
export interface SchemaSuggestion {
  draft: ComponentDraft;
  events: SuggestedEvent[];
  /** The extractor's own 0..1 estimate of how faithfully the proposal reflects the HTML. */
  confidence: number;
  /** The model that produced the proposal (LlmPort.modelId), for the audit trail. */
  model: string;
  /** Extractor identity + version, stamped like a rubric so a later prompt change is visible in lineage. */
  extractorId: string;
  extractorVersion: string;
  suggestedAt: string;
}

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

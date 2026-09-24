import type { ComponentDraft, PromotionCandidateView } from "@kohaku-ui/client";
import type { AdminMessages } from "../../messages.js";

/** The approval form state (JSON text inputs for the schema / query wiring section). */
export interface DraftForm {
  componentType: string;
  version: string;
  intentName: string;
  description: string;
  paramsJsonSchema: string;
  queryPath: string;
  fixedParams: string;
  paramMap: string;
}

/**
 * Product-specific knowledge for the approval form: which `queryTemplate.path` values the product's query
 * source supports, and how to prefill a draft from a candidate. Both default to something neutral; the kohaku
 * sample passes its sales-catalogue values from the app side (B2 will feed LLM-suggested drafts through the
 * same `initialDraftFor` seam).
 */
export interface PromotionDefaults {
  queryPaths?: readonly string[];
  initialDraftFor?: (candidate: PromotionCandidateView) => DraftForm;
  /**
   * When a candidate carries a machine-extracted `suggestion` (B2), prefill the form from it instead of
   * `initialDraftFor` (default true). `false` forces the product's own prefill; the suggestion panel and its
   * acknowledgement are still shown so the reviewer can compare.
   */
  preferSuggestion?: boolean;
}

export const DEFAULT_QUERY_PATHS: readonly string[] = [""];

/** Neutral prefill: the request text as description, everything else left for the reviewer. */
export function genericInitialDraft(candidate: PromotionCandidateView): DraftForm {
  return {
    componentType: "",
    version: "1.0.0",
    intentName: "",
    description: candidate.request ?? "",
    paramsJsonSchema: "",
    queryPath: "",
    fixedParams: "",
    paramMap: "",
  };
}

/**
 * Converts a DraftForm into the wire-form draft carried in the approve body. Empty fields are omitted
 * (delegated to the product default); invalid JSON returns an error and blocks submission.
 */
export function buildDraftPayload(
  draft: DraftForm,
  messages: AdminMessages,
): { ok: true; payload: ComponentDraft } | { ok: false; error: string } {
  const parseOptional = (label: string, text: string): { value: unknown } | { error: string } => {
    if (text.trim() === "") return { value: undefined };
    try {
      return { value: JSON.parse(text) };
    } catch (e) {
      return { error: messages.promotions.invalidJson(label, e instanceof Error ? e.message : String(e)) };
    }
  };
  const params = parseOptional("paramsJsonSchema", draft.paramsJsonSchema);
  if ("error" in params) return { ok: false, error: params.error };
  const fixed = parseOptional("fixedParams", draft.fixedParams);
  if ("error" in fixed) return { ok: false, error: fixed.error };
  const map = parseOptional("paramMap", draft.paramMap);
  if ("error" in map) return { ok: false, error: map.error };

  const payload: ComponentDraft = {
    componentType: draft.componentType,
    version: draft.version,
    intentName: draft.intentName,
    description: draft.description,
    ...(params.value !== undefined ? { paramsJsonSchema: params.value } : {}),
    ...(draft.queryPath.trim() !== ""
      ? {
          queryTemplate: {
            path: draft.queryPath.trim(),
            ...(fixed.value !== undefined ? { fixedParams: fixed.value as Record<string, string> } : {}),
            ...(map.value !== undefined ? { paramMap: map.value as Record<string, string> } : {}),
          },
        }
      : {}),
  };
  return { ok: true, payload };
}

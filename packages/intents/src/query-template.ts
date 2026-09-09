import { formatQueryRef } from "@kohaku-ui/data-binding";
import type { JsonObject, QueryHandle } from "@kohaku-ui/spec-core";

/**
 * Declarative query:// template. Expresses the mapping from intent params to query params purely by declaration.
 * Same shape as the promoted ComponentDraft.queryTemplate (unifying the promotion path and the core Intent path on the same helper).
 * - path: the query's path (e.g. "trend")
 * - fixedParams: fixed parameters always attached (values pass through; not filtered)
 * - paramMap: intent param name → query param name (only non-null / non-empty values are String()-converted and attached)
 */
export interface QueryTemplate {
  path: string;
  paramMap?: Record<string, string>;
  fixedParams?: Record<string, string>;
}

/**
 * Expands a QueryTemplate + params into a canonical query:// URI (QueryHandle).
 * Delegates canonicalization (key sorting, etc.) to data-binding's formatQueryRef (= spec-core's canonical form)
 * to avoid duplicate definitions. null / undefined / empty-string paramMap values are not attached (missing values pass through).
 */
export function compileQueryTemplate(
  source: string,
  template: QueryTemplate,
  params: JsonObject,
): QueryHandle {
  const queryParams: Record<string, string> = { ...(template.fixedParams ?? {}) };
  for (const [intentParam, queryParam] of Object.entries(template.paramMap ?? {})) {
    const value = params[intentParam];
    if (value != null && value !== "") queryParams[queryParam] = String(value);
  }
  return { uri: formatQueryRef({ source, path: template.path, params: queryParams }) };
}

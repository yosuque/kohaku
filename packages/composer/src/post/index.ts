import type { FilterDescriptor, UISpec } from "@kohaku-ui/spec-core";
import { type InjectFiltersResult, injectFilters } from "./inject-filters.js";
import { normalizeIds, STANDARD_RULES } from "./rules.js";
import type { PostProcessContext, PostRule } from "./types.js";

/** `ComposePolicy.l1Filters` injection request for {@link postProcess} (L1 only; see inject-filters.ts). */
export interface FilterInjection {
  descriptors: readonly FilterDescriptor[];
  /** `ComposePolicy.l1FiltersMaxVariants` (default 64). */
  maxVariants?: number;
  /** Receives the injection outcome (for ComposeTrace.filters); called once, only when descriptors is non-empty. */
  report?: (result: InjectFiltersResult) => void;
}

/**
 * The deterministic post-processor.
 * Applies the product-extension rules in order after the 4 standard rules
 * (normalizeIds → chartKind → sortOrder → canonicalProps). All rules are pure functions and idempotent.
 *
 * With `filters`, the Intent-declared filter injection (`injectFilters`) runs right after `normalizeIds`:
 * after it so the injected `filter-<param>` ids are not renamed, before the rest so the injected control
 * gets the same chart/sort/default-props treatment (and `version`) as every generated component.
 */
export function postProcess(
  spec: UISpec,
  ctx: PostProcessContext,
  extraRules: PostRule[] = [],
  filters?: FilterInjection,
): UISpec {
  const rules: PostRule[] = [];
  for (const rule of STANDARD_RULES) {
    rules.push(rule);
    if (rule === normalizeIds && filters != null && filters.descriptors.length > 0) {
      rules.push((acc) => {
        const result = injectFilters(acc, filters.descriptors, {
          ...(filters.maxVariants != null ? { maxVariants: filters.maxVariants } : {}),
        });
        filters.report?.(result);
        return result.spec;
      });
    }
  }
  return [...rules, ...extraRules].reduce((acc, rule) => rule(acc, ctx), spec);
}

export type { InjectFiltersResult } from "./inject-filters.js";
export { injectFilters } from "./inject-filters.js";
export { canonicalProps, chartKind, normalizeIds, STANDARD_RULES, sortOrder } from "./rules.js";
export type { PostProcessContext, PostRule } from "./types.js";

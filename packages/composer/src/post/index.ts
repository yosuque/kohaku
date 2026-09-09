import type { UISpec } from "@kohaku-ui/spec-core";
import { STANDARD_RULES } from "./rules.js";
import type { PostProcessContext, PostRule } from "./types.js";

/**
 * The deterministic post-processor.
 * Applies the product-extension rules in order after the 4 standard rules
 * (normalizeIds → chartKind → sortOrder → canonicalProps). All rules are pure functions and idempotent.
 */
export function postProcess(spec: UISpec, ctx: PostProcessContext, extraRules: PostRule[] = []): UISpec {
  return [...STANDARD_RULES, ...extraRules].reduce((acc, rule) => rule(acc, ctx), spec);
}

export { canonicalProps, chartKind, normalizeIds, STANDARD_RULES, sortOrder } from "./rules.js";
export type { PostProcessContext, PostRule } from "./types.js";

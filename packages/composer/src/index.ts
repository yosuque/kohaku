export {
  type BudgetVerdict,
  checkBudget,
  createDeadlineGuard,
  type DeadlineGuard,
  sumSpentTokens,
} from "./budget.js";
export {
  COMPOSER_ID,
  type ComposeInput,
  type ComposeOptions,
  type ComposeResult,
  compose,
  recompose,
} from "./compose.js";
export { type ComposeStreamInternalEvent, composeStream } from "./compose-stream.js";
export type {
  BudgetCheckErrorContext,
  ComposeBudget,
  ComposeContext,
  ComposeErrorContext,
  ComposeObserver,
  ComposePolicy,
  FewShotExample,
  FixedSpecSource,
  ResolvedRefs,
  TierLlmFingerprintMaterial,
} from "./context.js";
export {
  policyFingerprint,
  resolveTierLlm,
  tierLlmFingerprintMaterial,
  withSessionPolicy,
  withTenantCatalog,
} from "./context.js";
export {
  DEFAULT_KIT_SKELETON,
  DEFAULT_KIT_VOCABULARY,
  DEFAULT_TOKEN_DESCRIPTIONS,
  type DesignKitVocabulary,
  type DesignSystemGuide,
  designKitPromptFragment,
  designSystemPromptFragment,
  tokenToCssVar,
} from "./design-system.js";
export { ComposeError, type ComposeErrorCode } from "./errors.js";
export { buildFallbackSpec } from "./fallback.js";
export { type FixationCheck, materializeFixation } from "./fixation.js";
// The allowlist of window.kohaku bridge APIs that L2-generated HTML may use (single source of truth).
// The drift check against the surface the sandbox runtime actually exposes imports directly from
// the node-independent `@kohaku-ui/composer/l2-api` subpath (going through the barrel would pull
// node-dependent sources such as llm into type resolution and break downstream typecheck).
export { KOHAKU_API_ALLOWLIST } from "./l2-api.js";
export { composeObservers } from "./observer.js";
export {
  canonicalProps,
  chartKind,
  normalizeIds,
  type PostProcessContext,
  type PostRule,
  postProcess,
  STANDARD_RULES,
  sortOrder,
} from "./post/index.js";
export {
  appendL1RepairFeedback,
  appendL2RepairFeedback,
  type BuildL1PromptStaticArgs,
  type BuildL2PromptStaticArgs,
  buildL1Prompt,
  buildL1PromptParts,
  buildL1PromptStatic,
  buildL2Prompt,
  buildL2PromptParts,
  buildL2PromptStatic,
  defaultGeneratorVersion,
  L1_SYSTEM_PROMPT,
  L2_SYSTEM_PROMPT,
  PROMPT_REVISION,
} from "./prompt.js";
// <script> syntax check for L2-generated HTML (new Function compilation). The Python implementation,
// which has no JS execution engine, reuses just this checker from a CLI sidecar (kohaku smoke-l2 --lint).
export { collectScriptSyntaxIssues } from "./tiers/l2-generate.js";
export type { ComposeAttempt, ComposeTrace, TraceContext } from "./trace.js";

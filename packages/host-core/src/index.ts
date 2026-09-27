export { createKeyedMutex, type KeyedMutex } from "@kohaku-ui/spec-core";
export type { ActionAuditRecorder } from "./action-audit.js";
export { type ActionEffects, type ActionEffectsResponse, applyActionEffects } from "./action-effects.js";
export {
  type ActionGate,
  type ActionGateAllow,
  type ActionGateApprovalRequired,
  type ActionGateDenied,
  type ActionGateInvalid,
  type ActionGateOptions,
  type ActionGateRequest,
  type ActionGateResult,
  createActionGate,
} from "./action-gate.js";
export {
  type ActionManifest,
  type ActionManifestEntry,
  buildActionManifest,
} from "./action-manifest.js";
export { type AllowedActions, createAllowedActions } from "./allowed-actions.js";
export { type InvokableRef, type ParsedInvokableRef, parseInvokableRef } from "./binding-ref.js";
export {
  CAPABILITY_VERIFICATION_UNAVAILABLE_MESSAGE,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  type IssueCapabilityOptions,
  issueCapabilityForRefs,
  issueCapabilityForSpec,
  issueSpecCapabilitySafely,
  type VerifyCapabilitySafelyResult,
  verifyCapabilitySafely,
  WriteScopeDroppedError,
} from "./capability.js";
export {
  type AnalyzeCatalogImpactOptions,
  analyzeCatalogImpact,
  type CatalogDeprecatedUsageEntry,
  type CatalogFixationIssue,
  type CatalogImpactReport,
  type CatalogOriginKitMismatch,
  type CatalogPublishedPromotionIssue,
} from "./catalog-impact.js";
export {
  type ApplyCatalogMigrationOptions,
  applyCatalogMigration,
  type CatalogMigrationApplyBlocked,
  type CatalogMigrationApplyResult,
  type CatalogMigrationBlocked,
  type CatalogMigrationFixationReplacer,
  type CatalogMigrationPlan,
  type CatalogMigrationRewrite,
  type CatalogMigrationStep,
  type PlanCatalogMigrationOptions,
  planCatalogMigration,
  verifyCatalogMigrationPlan,
} from "./catalog-migration.js";
export {
  type CreateDailyTokenLedgerOptions,
  createDailyTokenLedger,
  type DailyTokenLedger,
} from "./daily-token-ledger.js";
export {
  type ConsoleErrorReporter,
  type ConsoleErrorReporterOptions,
  clientMessageFor,
  createConsoleErrorReporter,
  errorMessage,
  failOpen,
  formatErrorChain,
  isTypedHostError,
  notifyHook,
} from "./errors.js";
export {
  composeWithFixation,
  type FixationDeliveryHost,
  type FixationSelfHealApi,
  type FixationSelfHealEndpoint,
  resolveFixatedResult,
  settleFixation,
} from "./fixation.js";
export { type IntentSource, resolveIntent } from "./intent.js";
export {
  createOperationIndex,
  type OperationIndex,
  type OperationIndexEntry,
} from "./operation-index.js";
export {
  type CreatePolicyRuntimeOptions,
  createPolicyRuntime,
  type ParsedPolicy,
  type PolicyAppliedEvent,
  type PolicyRateLimiter,
  type PolicyRateLimiterTakeParams,
  type PolicyRuntime,
  parsePolicy,
} from "./policy.js";
export {
  type CreateMemoryRateLimitStoreOptions,
  createMemoryRateLimitStore,
  createRateLimiter,
  DEFAULT_MAX_MEMORY_ENTRIES,
  type RateLimiter,
  type RateLimiterErrorInfo,
  type RateLimiterTakeParams,
} from "./rate-limit.js";
export { parseTraceContext, TRACEPARENT_RE } from "./trace-context.js";
export { recordComposedResult, recordViewFallback, type ViewRecorder } from "./view-recorder.js";

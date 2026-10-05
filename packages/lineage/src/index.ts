export {
  type IntentUsage,
  type L2IntentGap,
  type LineageSummary,
  mergeUsageRows,
  type SchemaEditGap,
  type SummarizeLineageOptions,
  type SummarizeUsageOptions,
  summarizeLineage,
  summarizeUsage,
  type UsageRow,
} from "./analytics.js";
export {
  ACTION_EVENT_TYPES,
  type ActionApprovalRequestedPayload,
  type ActionApprovedPayload,
  type ActionDeniedPayload,
  type ActionInvokedPayload,
  COMPONENT_EVENT_TYPES,
  type ComponentGeneratedPayload,
  type ComponentSchemaEditedPayload,
  type ComponentSchemaSuggestedPayload,
  type ComponentUsedPayload,
  FIXATION_EVENT_TYPES,
  type LineageEventType,
  makeEvent,
  POLICY_EVENT_TYPES,
  type PolicyAppliedPayload,
  VIEW_EVENT_TYPES,
  type ViewComposedPayload,
} from "./events.js";
// Compliance Evidence Pack (design.md #67). Appended at the end (rather than interleaved above in
// alphabetical file order) to keep this file's diff merge-friendly against other in-flight work on it.
export {
  type BuildEvidencePackOptions,
  type BuiltEvidencePack,
  buildEvidencePack,
  EVIDENCE_APPROVAL_EVENT_TYPES,
  type EvidencePackFile,
  type EvidencePackScope,
} from "./evidence/build.js";
export {
  EVIDENCE_PACK_FORMAT,
  EVIDENCE_PACK_VERSION,
  type EvidenceFileEntry,
  type EvidenceManifest,
  type EvidenceManifestCounts,
  EvidenceManifestSchema,
  type EvidenceManifestScope,
  type EvidenceManifestSigner,
} from "./evidence/manifest.js";
export {
  deriveEd25519KeyId,
  type Ed25519KeyPair,
  type Ed25519PrivateKey,
  type Ed25519PublicKey,
  type EvidencePackReader,
  exportEd25519PrivateKeyPkcs8,
  exportEd25519PublicKeyRaw,
  exportEd25519PublicKeySpki,
  generateEd25519KeyPair,
  importEd25519PrivateKeyPkcs8,
  importEd25519PublicKeyRaw,
  importEd25519PublicKeySpki,
  signBytes,
  signManifest,
  type VerifyEvidencePackResult,
  verifyBytes,
  verifyEvidencePack,
  verifyManifestSignature,
} from "./evidence/sign.js";
export { createStorageEvidenceSource, type EvidenceSource } from "./evidence/source.js";
export {
  createFixations,
  DEFAULT_FIXATION_POLICY,
  FixationNotAllowedError,
  type FixationPolicy,
  type FixationProposal,
  type Fixations,
  FixationUnsupportedError,
  type InvalidateOptions,
  type ReplaceOptions,
} from "./fixation/service.js";
export {
  artifactIdOf,
  type ComposeTraceLike,
  createLineage,
  type Lineage,
} from "./lineage.js";
export { iterateLineagePages, type LineagePageSource } from "./paging.js";
export {
  type SchemaEditExample,
  type SchemaEditExamplesOptions,
  schemaEditExamples,
} from "./promotion/examples.js";
export {
  type ComponentDraft,
  isTerminal,
  type JudgeVerdict,
  type MachinePolicy,
  mayHaveProjection,
  type PromotionAction,
  type PromotionStatus,
  TransitionError,
  transition,
} from "./promotion/machine.js";
export {
  type ApproveOptions,
  createPromotions,
  DEFAULT_PROMOTION_POLICY,
  DEFAULT_SUGGEST_CONCURRENCY,
  type PromotionCandidate,
  PromotionChainError,
  type PromotionErrorContext,
  type PromotionErrorEndpoint,
  type PromotionJudge,
  type PromotionJudgeContext,
  PromotionNotPublishedError,
  PromotionNotRejectedError,
  type PromotionOrigin,
  type PromotionPolicy,
  type Promotions,
  type WithdrawOptions,
} from "./promotion/service.js";
export {
  type DraftDiff,
  type DraftDiffField,
  type DraftFieldChange,
  diffDraft,
  type SchemaSuggestion,
  type SuggestedEvent,
} from "./promotion/suggestion.js";
export {
  type CreateActionAuditRecorderOptions,
  createActionAuditRecorder,
  createViewRecorder,
  type RestActionAuditRecorder,
  type RestViewRecorder,
} from "./recorder.js";
export type { TenantScope } from "./tenant-scope.js";

// Schemas

export { collectWriteActions, resolveWriteActionName } from "./action-name.js";
export { enumerateBindVariants, resolveBoundRef } from "./bind.js";
export {
  type CacheKeyParts,
  cacheKey,
  combineDataVersions,
  computeSpecHash,
  computeStructureHash,
} from "./cache-key.js";
// Canonicalization / intent / cache
export { canonicalStringify, normalizeJsonValue, sha256Hex } from "./canonical-json.js";
export { collectCapabilityScopes } from "./capability-scopes.js";
// Diff / patch
export { applyPatch, diffSpec, orderComponents, type SpecPatch } from "./diff.js";
export { SpecError, type SpecErrorCode } from "./errors.js";
export {
  computeIntentHash,
  finalizeIntent,
  type IntentInput,
  normalizeIntent,
} from "./intent.js";
// In-process keyed mutex (a shared primitive: host locks and the reference StoragePort's per-file serialization)
export { createKeyedMutex, type KeyedMutex } from "./keyed-mutex.js";
// Parsing / validation
export {
  parsePatch,
  parseSpec,
  type SafeParsePatchResult,
  type SafeParseResult,
  safeParsePatch,
  safeParseSpec,
} from "./parse.js";
export type {
  AuthzPort,
  CatalogContribution,
  DomainPort,
  FixationRecord,
  GuiAction,
  InvocationContext,
  KnownThemeTokens,
  LineageEventRecord,
  LineageFilter,
  NLQuery,
  OperationDescriptor,
  Principal,
  PromotionState,
  QueryHandle,
  Scope,
  SemanticInput,
  SemanticPort,
  SessionContext,
  StoragePort,
  Surface,
  ThemeTokens,
  VerifyRequest,
  VerifyResult,
} from "./ports.js";
// Ports
export { DEFAULT_CAPABILITY_TTL_SECONDS } from "./ports.js";
export { collectStateRefs, evaluateVisibleWhen } from "./predicate.js";
export {
  formatQueryRef,
  parseQueryRef,
  type QueryRef,
  QueryRefError,
} from "./query-ref.js";
// Error envelope of the REST profile (SPEC §6.1) (a wire contract shared by host-rest / client).
export type { ErrorEnvelope, HostErrorCode } from "./rest-errors.js";
export { GOVERNANCE_ERROR_DISCRIMINATORS, PROMOTION_ERROR_DISCRIMINATORS } from "./rest-errors.js";
export {
  type BindParam,
  BindParamSchema,
  ComponentIdSchema,
  type ComponentNode,
  ComponentNodeSchema,
  type DataRef,
  DataRefSchema,
  SANDBOX_HTML_TYPE,
  type SandboxArtifactRef,
  SandboxArtifactRefSchema,
} from "./schema/component.js";
export { type EventBinding, EventBindingSchema, EventOnSchema } from "./schema/events.js";
export {
  type CanonicalIntent,
  CanonicalNameSchema,
  IntentHashSchema,
  IntentSchema,
} from "./schema/intent.js";
export {
  type JsonObject,
  JsonObjectSchema,
  type JsonValue,
  JsonValueSchema,
  MAX_JSON_OBJECT_DEPTH,
} from "./schema/json.js";
export { SpecPatchSchema } from "./schema/patch.js";
export {
  FixationRecordSchema,
  LineageEventRecordSchema,
  PromotionStateSchema,
} from "./schema/persistence.js";
export { type Provenance, ProvenanceSchema } from "./schema/provenance.js";
export {
  ALLOWED_ATTR_PREFIXES,
  ALLOWED_ATTRS,
  ALLOWED_PROPERTY_OPS,
  ALLOWED_STYLE_PROPS,
  ALLOWED_TAGS,
  ALWAYS_DENIED_ATTRS,
  containsJavascriptScheme,
  DEFAULT_MAX_DOM_DEPTH,
  DEFAULT_MAX_DOM_NODES,
  DEFAULT_MUTATIONS_PER_MINUTE,
  EXPLICITLY_DENIED_TAGS,
  isAttrAllowed,
  isAttrValueSafe,
  isStylePropAllowed,
  isStyleValueSafe,
  isTagAllowed,
  toKebabCase,
  VOID_TAGS,
} from "./schema/sandbox-dom.js";
export {
  ACCEPTED_SPEC_VERSIONS,
  SPEC_VERSION,
  type UISpec,
  UISpecSchema,
} from "./schema/spec.js";
export {
  type LeafPredicate,
  LeafPredicateSchema,
  MAX_PREDICATE_DEPTH,
  MAX_PREDICATE_ITEMS,
  StateKeySchema,
  StateRefSchema,
  type VisibleWhen,
  VisibleWhenSchema,
} from "./schema/state.js";
// Text summary (fallback for hosts without UI support / the feed-back text for ui/update-model-context)
export { specToText } from "./spec-text.js";

// Tabular
export type { ColumnType, DataShape, TabularColumn, TabularData } from "./tabular.js";
export {
  hasErrors,
  MAX_BIND_VARIANTS,
  ROOT_COMPONENT_ID,
  type SpecIssue,
  type SpecIssueCode,
  validateSpecStructure,
} from "./validate.js";

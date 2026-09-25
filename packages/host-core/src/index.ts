export { createKeyedMutex, type KeyedMutex } from "@kohaku-ui/spec-core";
export { type ActionEffects, type ActionEffectsResponse, applyActionEffects } from "./action-effects.js";
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
export { clientMessageFor, errorMessage, failOpen, isTypedHostError, notifyHook } from "./errors.js";
export {
  composeWithFixation,
  type FixationDeliveryHost,
  type FixationSelfHealApi,
  type FixationSelfHealEndpoint,
  resolveFixatedResult,
  settleFixation,
} from "./fixation.js";
export { type IntentSource, resolveIntent } from "./intent.js";
export { parseTraceContext, TRACEPARENT_RE } from "./trace-context.js";
export { recordComposedResult, recordViewFallback, type ViewRecorder } from "./view-recorder.js";

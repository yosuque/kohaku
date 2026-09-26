// The typed host client itself

// Reference-passing data binding (re-export from data-binding — no duplicate implementation)
export {
  type ActionResult,
  type BindingClient,
  type BindingClientConfig,
  BindingError,
  type BindingErrorCode,
  createBindingClient,
  type ResolveOptions,
} from "@kohaku-ui/data-binding";
// Wire contract for error codes (defined in spec-core; importing from here gives the same type as host-rest)
export type { ErrorEnvelope, HostErrorCode } from "@kohaku-ui/spec-core";
export {
  type AnalyticsClient,
  type AnalyticsSummaryQuery,
  createKohakuClient,
  type FixationsClient,
  type KohakuClient,
  type KohakuClientConfig,
  type LineagePageQuery,
  type LineageQuery,
  type PromotionApproveOptions,
  type PromotionsClient,
  type RequestOptions,
  type TelemetryEvent,
} from "./client.js";
// Errors (discriminable exception)
export { hostErrorFromResponse, isKohakuHostError, KohakuHostError } from "./errors.js";
// kohaku explain <requestId> / admin-react DevTools: the pure report builder + its types
export {
  buildExplainReport,
  type ExplainCompose,
  type ExplainDecision,
  type ExplainDecisionAttempt,
  type ExplainDecisionDowngrade,
  type ExplainReport,
} from "./explain.js";
// SSE stream (typed events + low-level reader)
export {
  type ComposeStreamEvent,
  type ComposeStreamWireEvent,
  readComposeStream,
  toComposeStreamEvent,
} from "./stream.js";
// Transport dependency injection
export { globalTransport, type Transport } from "./transport.js";
// Request / response types
export type {
  AnalyticsSummaryView,
  CatalogResponse,
  ComponentDraft,
  ComposeRequest,
  ComposeView,
  FixationProposalView,
  FixationRecordView,
  IntentArg,
  NormalizeRequest,
  NormalizeResult,
  PromotionAction,
  PromotionCandidateView,
  PromotionPreviewView,
  PromotionReconcileSummaryView,
  SchemaSuggestionView,
  SendEventRequest,
  SerializedComponentDef,
  SerializedDeprecation,
  SessionArg,
  SuggestedEventView,
} from "./types.js";

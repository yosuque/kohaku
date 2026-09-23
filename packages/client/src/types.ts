import type { CanonicalIntent, JsonObject, SemanticInput, UISpec } from "@kohaku-ui/spec-core";

/** Session info (surface / sessionId / locale). Maps onto the `session` field of each REST body. */
export interface SessionArg {
  surface?: string;
  sessionId?: string;
  /** Locale tag ("en" / "ja"). Lets the host vary NL hints and generation output language. */
  locale?: string;
}

/** Normalized Intent (canonical + params). Used as input to /compose, /events, and /fixations. */
export interface IntentArg {
  canonical: string;
  params: JsonObject;
}

/** Request for POST /compose (`{intent}` or `{input}`; SPEC §6.1). */
export interface ComposeRequest {
  intent?: IntentArg;
  input?: SemanticInput;
  session?: SessionArg;
}

/** Success response for POST /compose, /events, and /compose/stream. */
export interface ComposeView {
  spec: UISpec;
  capability: string;
}

/** Request for POST /intent/normalize (natural language or GUI action). */
export interface NormalizeRequest {
  input: SemanticInput;
  session?: SessionArg;
}

/** Success response for POST /intent/normalize. source is the normalization path (LLM / deterministic). */
export interface NormalizeResult {
  intent: CanonicalIntent;
  source: "llm" | "deterministic";
}

/** Request for POST /events (component event → Intent delta → recompose). */
export interface SendEventRequest {
  intent: IntentArg;
  on: string;
  payload: JsonObject;
  session?: SessionArg;
}

/** Serialized form of a ComponentDefinition returned by GET /catalog (one entry). */
export interface SerializedComponentDef {
  type: string;
  version: string;
  description?: string;
  capabilities?: string[];
  implementation: { kind: string } & Record<string, unknown>;
  propsSchema: unknown;
}

/** Response of GET /catalog. */
export interface CatalogResponse {
  components: SerializedComponentDef[];
  catalogVersion: string;
}

/**
 * Wire shape of a promotion ComponentDraft (body of POST /promotions/:id/approve; structurally matched to
 * host-rest's ComponentDraftSchema). Because of the dependency direction, host-rest's type is not imported but
 * mirrored on the client side (a mapping of the wire contract).
 */
export interface ComponentDraft {
  componentType: string;
  version: string;
  intentName: string;
  description: string;
  paramsJsonSchema?: unknown;
  queryTemplate?: {
    path: string;
    fixedParams?: Record<string, string>;
    paramMap?: Record<string, string>;
  };
}

/** One event the extractor believes the component emits (element of SchemaSuggestionView.events). */
export interface SuggestedEventView {
  name: string;
  description: string;
}

/**
 * View shape of the machine-extracted registration proposal a candidate may carry (`suggestion` on the
 * GET/POST /promotions… candidate JSON; additive optional). Advisory: the admin UI prefills its approval form
 * from `draft` and shows the reviewer's edits as a diff; approving still sends the reviewer's own draft.
 */
export interface SchemaSuggestionView {
  draft: ComponentDraft;
  events: SuggestedEventView[];
  confidence: number;
  model: string;
  extractorId: string;
  extractorVersion: string;
  suggestedAt: string;
}

/**
 * View shape of a promotion candidate (element of GET/POST /promotions… responses). A loose copy holding only
 * the fields the admin UI (sample-web AdminPage) actually reads, so it does not depend on lineage's internal candidate type.
 */
export interface PromotionCandidateView {
  artifactId: string;
  status: string;
  request?: string;
  html?: string;
  uses: number;
  sessions: number;
  verdict?: { pass: boolean; score: number };
  suggestion?: SchemaSuggestionView;
  updatedAt: string;
}

/**
 * View shape of the summary returned by POST /promotions/reconcile (#11): how many published/withdrawn
 * snapshots had their projection re-applied, and how many were skipped because the data needed to rebuild the
 * projection was unrecoverable (reported server-side via the onError observability hook).
 */
export interface PromotionReconcileSummaryView {
  published: number;
  withdrawn: number;
  skipped: number;
}

/**
 * View shape of a promotion candidate preview (response of POST /promotions/:id/preview). Material to remount
 * the review subject itself (the recorded artifact). ref / capability are present only when a data reference was
 * recorded at generation time (capability is a read scope limited to that single reference).
 */
export interface PromotionPreviewView {
  html: string;
  sha256: string;
  ref?: string;
  capability?: string;
}

/** View shape of a fixation proposal (element of the GET /fixations/proposals response). */
export interface FixationProposalView {
  intentHash: string;
  canonical: string;
  params?: JsonObject;
  uses: number;
  stability: number;
}

/** View shape of a fixated record (element of the GET /fixations response). */
export interface FixationRecordView {
  intentHash: string;
  canonical: string;
  fixatedAt: string;
}

/**
 * View shape of the aggregated usage-analytics summary (response of GET /analytics/summary; SPEC governance
 * plane, host-rest's `registerGovernanceRoutes`). Only the fields the admin UI (sample-web AnalyticsTab) reads.
 */
export interface AnalyticsSummaryView {
  window: { limit: number; truncated: boolean; since?: string; until?: string; tenant?: string };
  summary: {
    events: number;
    composed: number;
    tiers: { L0: number; L1: number; L2: number };
    cache: { hit: number; miss: number; bypass: number; fixated: number; other: number };
    fallback: {
      total: number;
      byKind: { generation: number; negotiation: number; unspecified: number };
      rate: number;
    };
    durationMs: {
      count: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
      max: number | null;
    };
    topIntents: { intentHash: string; canonical: string; count: number }[];
    promotions: {
      generated: number;
      used: number;
      nominated: number;
      schemaSuggested: number;
      judged: number;
      reviewed: number;
      schemaEdited: number;
      published: number;
      withdrawn: number;
    };
    fixations: { fixated: number; unfixated: number };
    /** Human review turnaround (component.nominated → component.reviewed approve|reject) and zero-edit acceptances. */
    review: {
      count: number;
      durationMs: { p50: number | null; p95: number | null; max: number | null };
      acceptedAsIs: number;
    };
  };
  /**
   * Nomination thresholds for promotion / fixation candidates ("N or more uses"), when the host bundles them
   * (sample-api's response-rewriting middleware; host-rest's own route never sets this field). Lets an admin
   * UI source its "candidates appear after N uses" copy from the server instead of duplicating the numbers as
   * literals.
   */
  promotionPolicy?: { fixationMinUses: number; promotionMinUses: number };
}

/**
 * Generic promotion action (the `action` field of POST /promotions/:id/actions). Corresponds to host-rest's
 * PromotionActionSchema. reviewer / by (Principal) are injected by the server-side principal, so the client does not declare them.
 */
export type PromotionAction =
  | { kind: "nominate" }
  | { kind: "judge.start" }
  | { kind: "judge.result"; verdict: { pass: boolean; score: number } }
  | { kind: "review.start" }
  | { kind: "review.approve"; comment?: string }
  | { kind: "review.requestChanges"; comment?: string }
  | { kind: "review.reject"; comment?: string }
  | { kind: "schema.propose"; draft: ComponentDraft }
  | { kind: "publish"; version: string }
  | { kind: "withdraw"; reason?: string }
  | { kind: "unpublish"; reason?: string };

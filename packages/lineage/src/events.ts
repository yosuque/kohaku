import type { CacheKeyParts, LineageEventRecord } from "@kohaku-ui/spec-core";
import type { DraftDiffField, DraftFieldChange, SchemaSuggestion } from "./promotion/suggestion.js";
import { tenantField } from "./tenant-scope.js";

/**
 * Lineage event type catalog.
 * Two families: View Lineage (why this view was shown = Event Sourcing of the UI Spec) and
 * Component Lineage (a component's generation / review / promotion provenance).
 */
export const VIEW_EVENT_TYPES = [
  "view.composed",
  "view.rendered",
  "view.interacted",
  "view.fallback",
] as const;

// Rejection has no standalone event (component.rejected): a rejection is recorded as the review.reject
// transition on component.reviewed (decision:"reject", reviewer) (see act in service.ts).
// A standalone component.rejected was never fired and would only bloat history queries as a dead
// vocabulary term, so it was removed from the declaration (spec/SPEC.md §5's required audit items do not
// include component.rejected either).
export const COMPONENT_EVENT_TYPES = [
  "component.generated",
  "component.used",
  "component.nominated",
  // A machine-extracted registration proposal was attached to a freshly nominated candidate (advisory; see
  // promotion/suggestion.ts). Recorded with a model actor right after component.nominated.
  "component.schemaSuggested",
  "component.judged",
  "component.reviewed",
  // The reviewer's field-level edits against the suggestion, recorded on the approve path next to
  // component.schemaProposed. `changed: []` means the suggestion was accepted as-is.
  "component.schemaEdited",
  "component.schemaProposed",
  "component.published",
  "component.withdrawn",
] as const;

// intent.fixated / intent.unfixated are fired by the fixations service. intent.observed is an
// **intentionally reserved type** that is not fired in v0.1 (docs/specification.md §10 "reservation in the
// type catalog"). It remains in the type catalog as room to later introduce Intent observation (recording
// frequently-used Intents).
export const FIXATION_EVENT_TYPES = ["intent.observed", "intent.fixated", "intent.unfixated"] as const;

export type LineageEventType =
  | (typeof VIEW_EVENT_TYPES)[number]
  | (typeof COMPONENT_EVENT_TYPES)[number]
  | (typeof FIXATION_EVENT_TYPES)[number];

/** One L1/L2 generation attempt, as recorded on view.composed's `decision` summary (structural subset of
 * @kohaku-ui/composer's ComposeAttempt -- lineage does not depend on composer, see ComposeTraceLike's doc). */
export interface ViewDecisionAttempt {
  kind: "l1" | "l2";
  ok: boolean;
  /**
   * For a validation-failed attempt (schema/catalog issues describing the model's own structural output),
   * these are the actual issue strings, capped to at most 5 entries of at most 200 characters each (see
   * lineage.ts's truncateIssues) so a verbose validation-error trail cannot bloat the lineage record without
   * bound. For a thrown-exception attempt (`errorCode` set below), this instead holds exactly one fixed,
   * non-sensitive message for that code -- never the exception's own `.message`.
   */
  issues?: string[];
  /**
   * Set only when this attempt failed by a thrown exception (never by a schema/catalog validation rejection
   * of a successfully-parsed draft) -- a closed, non-sensitive vocabulary (composer's own `LlmErrorCode`, or
   * `"UNKNOWN"` for a non-`LlmError` throw). See lineage.ts's `buildDecision`: a provider/network error's own
   * message can carry a hostname, URL, or account details a `lineage.read` principal (via `/lineage`,
   * `kohaku explain`, or DevTools) has no business seeing, so it is never persisted here.
   */
  errorCode?: "CONFIG" | "INVALID_OUTPUT" | "PROVIDER" | "ABORTED" | "UNKNOWN";
}

/** One capability-negotiation downgrade, as recorded on view.composed's `decision` summary (structural
 * subset of @kohaku-ui/registry's Downgrade -- lineage does not depend on registry either). */
export interface ViewDecisionDowngrade {
  id: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * Summarizes "what compose actually did" for a devtool (`kohaku explain`, admin-react's DevTools) trying to
 * answer "why did this view come out this way" -- the L1/L2 attempts (with their failure issues, capped),
 * any capability-negotiation downgrades, whether this compose rode along on another one under single-flight,
 * and the summed LLM token usage. Recorded only when there is something to summarize (see lineage.ts's
 * buildDecision): a cache hit / L0 fixed Spec with no attempts, downgrades, coalescing, or usage leaves this
 * key off the payload entirely, same as every other optional field here.
 */
export interface ViewComposedDecision {
  attempts: ViewDecisionAttempt[];
  downgrades?: ViewDecisionDowngrade[];
  coalesced?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ViewComposedPayload {
  specHash: string;
  intentHash: string;
  canonical: string;
  dataVersion: string;
  tier: "L0" | "L1" | "L2";
  cache: string;
  surface: string;
  sessionId?: string;
  model?: string;
  durationMs?: number;
  /** For L2: the artifact reference of the generated component */
  artifactId?: string;
  /** The caller-supplied correlation id (the compose trace's correlationId), so a devtool can find every
   * lineage event belonging to one request via the `/lineage?correlationId=` filter. Unset for a compose
   * whose caller passed none, and always unset for an event recorded before this field existed (LQ/U2). */
  correlationId?: string;
  /** The Spec cache key this compose resolved to (opaque; see cacheKeyParts for its breakdown). */
  cacheKey?: string;
  /** The individual components `cacheKey` was built from (see @kohaku-ui/spec-core's CacheKeyParts). */
  cacheKeyParts?: CacheKeyParts;
  /** The host's generator identity in effect at composition time (spec.provenance.generatorVersion). */
  generatorVersion?: string;
  /** The design kit the generated markup was written against (spec.provenance.kit). */
  kit?: { id: string; version: string };
  /** The demotion trace when this Spec is a deterministic/negotiation fallback (spec.provenance.fallback). */
  fallback?: { from: string; reason: string; kind?: "generation" | "negotiation" };
  /** A summary of the compose decision (attempts / downgrades / coalescing / token usage). See
   * ViewComposedDecision's doc comment for when this key is present. */
  decision?: ViewComposedDecision;
}

export interface ComponentGeneratedPayload {
  artifactId: string;
  artifactSha256: string;
  intentHash: string;
  canonical: string;
  specHash: string;
  model?: string;
  /** The request text to display in the promotion review (e.g. sales.custom's request) */
  request?: string;
  /** The artifact body (inline HTML). Used for the promotion review preview and publish */
  html?: string;
  /** The data reference at generation time (the sandbox node's data.$ref). Used to re-mount the preview */
  ref?: string;
  /** The compose trace's correlation id (see ViewComposedPayload.correlationId's doc comment). */
  correlationId?: string;
  /** The design kit the generated markup was written against (spec.provenance.kit). Read by F7 (the
   * promotion review) to show which kit a candidate component was generated against. */
  kit?: { id: string; version: string };
  /** The host's generator identity in effect at generation time (spec.provenance.generatorVersion). Read by
   * F7 alongside `kit` above. */
  generatorVersion?: string;
}

export interface ComponentUsedPayload {
  artifactId: string;
  intentHash?: string;
  surface: string;
  sessionId?: string;
  outcome: "ok" | "error";
  /**
   * Recording path. "compose" = the compose-time record inside viewComposed (server-authoritative, the source
   * of truth for promotion aggregation). "telemetry" = the actual-render observation via /telemetry, which is
   * excluded from the promotion-aggregation uses. The compose path leaves this unset (absent = counted as
   * equivalent to compose).
   */
  source?: "compose" | "telemetry";
  /** The compose trace's correlation id (see ViewComposedPayload.correlationId's doc comment). Only ever set
   * on the compose-time recording inside viewComposed -- a later `componentUsed` telemetry call has no
   * compose trace to read a correlation id from. */
  correlationId?: string;
}

export interface ComponentSchemaSuggestedPayload {
  artifactId: string;
  suggestion: SchemaSuggestion;
}

export interface ComponentSchemaEditedPayload {
  artifactId: string;
  reviewer: string;
  extractorId: string;
  extractorVersion: string;
  changed: DraftFieldChange[];
  unchanged: DraftDiffField[];
}

export type ActorKind = LineageEventRecord["actor"];

export function makeEvent(
  id: string,
  type: LineageEventType,
  payload: Record<string, unknown>,
  actor: ActorKind = { kind: "system" },
  tenant?: string,
  /** Clock injection point (tests only; defaults to the real wall clock). */
  now: () => Date = () => new Date(),
): LineageEventRecord {
  return {
    id,
    ts: now().toISOString(),
    actor,
    type,
    payload,
    // The tenant is put on the record only when non-null (keeps the persistence format unchanged for single-tenant users).
    ...tenantField(tenant),
  };
}

import type { CacheKeyParts, JsonObject, LineageEventRecord } from "@kohaku-ui/spec-core";
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

// intent.fixated / intent.unfixated / intent.migrated are fired by the fixations service. intent.observed
// is an **intentionally reserved type** that is not fired in v0.1 (docs/specification.md §10 "reservation
// in the type catalog"). It remains in the type catalog as room to later introduce Intent observation
// (recording frequently-used Intents). intent.migrated (design.md #65) is fired by Fixations.replace when
// a catalog migration rewrites a fixated Spec's components in place (structureHash changes, intentHash and
// the fixation's identity do not) — see fixation/service.ts's `replace`.
export const FIXATION_EVENT_TYPES = [
  "intent.observed",
  "intent.fixated",
  "intent.unfixated",
  "intent.migrated",
] as const;

/**
 * Policy as Code's audit trail (design.md #69). Fired by host-core's `PolicyRuntime.reload()` only
 * when the effective policyId actually changes (the dedup rule -- "a byte-identical reload is not
 * audit-worthy" -- lives in host-core, not here; this event type exists purely to record the ones
 * that already passed that check).
 */
export const POLICY_EVENT_TYPES = ["policy.applied"] as const;

/**
 * Governed Actions' audit trail (design.md #62/#63). Fired by `createActionAuditRecorder`'s adapter
 * (recorder.ts), driven by host-core's `ActionGate` outcome for every invoke attempt:
 * - `action.invoked` — the gate returned `allow` (params validated, tier satisfied). Recorded before
 *   `DomainPort.invoke` runs: "allowed by the gate", not "the write succeeded" (an approval token is
 *   already consumed by then).
 * - `action.denied` — tier `"approve"` and a token *was* presented but did not verify (or no
 *   `ApprovalPort` is configured at all).
 * - `action.approvalRequested` — nothing was presented yet (`"confirm"` without `confirmed: true`, or
 *   `"approve"` without a token).
 * - `action.approved` — tier `"approve"` and the presented approval grant was successfully consumed
 *   (recorded in addition to, not instead of, `action.invoked`).
 */
export const ACTION_EVENT_TYPES = [
  "action.invoked",
  "action.denied",
  "action.approvalRequested",
  "action.approved",
] as const;

export type LineageEventType =
  | (typeof VIEW_EVENT_TYPES)[number]
  | (typeof COMPONENT_EVENT_TYPES)[number]
  | (typeof FIXATION_EVENT_TYPES)[number]
  | (typeof POLICY_EVENT_TYPES)[number]
  | (typeof ACTION_EVENT_TYPES)[number];

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

/**
 * Payload of `policy.applied` (design.md #69). Structurally identical to host-core's
 * `PolicyAppliedEvent` (packages/host-core/src/policy.ts) -- duplicated here rather than imported, the
 * same convention every other payload type in this file follows (`ViewComposedPayload` /
 * `ComponentGeneratedPayload` etc. are never imported from the package that produces them, even where
 * lineage's dependency direction would allow it): a `LineageEventRecord.payload` shape is a wire/audit
 * concern owned by this file, kept independent of whichever caller happens to produce matching data
 * today.
 */
export interface PolicyAppliedPayload {
  policyId: string;
  previousPolicyId?: string;
  version: number;
  label?: string;
  changedPaths: string[];
  tenants: string[];
}

/**
 * Payload of `action.invoked` (design.md #62/#63). Only `payloadHash` is recorded, never the invoke
 * payload itself -- the audit trail proves *that* a specific payload (by hash) was invoked and under
 * which tier, without persisting whatever business data the payload carried.
 */
export interface ActionInvokedPayload {
  action: string;
  payloadHash: string;
  tier: "auto" | "confirm" | "approve";
  correlationId?: string;
}

/** Payload of `action.denied` (design.md #62/#63): either an `"approve"`-tier invoke whose presented
 * token did not verify (or no `ApprovalPort` was configured at all; `tier` is `"confirm"` or
 * `"approve"`), or an invoke whose action name is not one of the `DomainPort`'s own declared operations,
 * rejected before any governed-action gate ever ran (`tier` is `"auto"`). */
export interface ActionDeniedPayload {
  action: string;
  payloadHash: string;
  tier: "auto" | "confirm" | "approve";
  reason: string;
  correlationId?: string;
}

/**
 * Payload of `action.approvalRequested` (design.md #63): nothing was presented yet for a `"confirm"` or
 * `"approve"`-tier invoke. `payload` (the raw invoke payload, not just its hash) is included only when
 * the recorder is configured with `recordPayload: true` -- the default omits it, matching every other
 * action.* event's "hash only" stance; an operator opts in when an approver-facing flow needs to see the
 * actual content being approved (e.g. the note text of an `annotate` action) rather than just its hash.
 */
export interface ActionApprovalRequestedPayload {
  action: string;
  payloadHash: string;
  tier: "confirm" | "approve";
  requestId: string;
  payload?: JsonObject;
  correlationId?: string;
}

/** Payload of `action.approved` (design.md #63): an `"approve"`-tier invoke whose presented approval
 * grant was successfully consumed. Recorded in addition to (not instead of) `action.invoked`. */
export interface ActionApprovedPayload {
  action: string;
  payloadHash: string;
  approverId: string;
  requesterId: string;
  correlationId?: string;
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

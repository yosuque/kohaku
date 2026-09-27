import type { LineageEventRecord } from "@kohaku-ui/spec-core";
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

/**
 * Policy as Code's audit trail (design.md #69). Fired by host-core's `PolicyRuntime.reload()` only
 * when the effective policyId actually changes (the dedup rule -- "a byte-identical reload is not
 * audit-worthy" -- lives in host-core, not here; this event type exists purely to record the ones
 * that already passed that check).
 */
export const POLICY_EVENT_TYPES = ["policy.applied"] as const;

export type LineageEventType =
  | (typeof VIEW_EVENT_TYPES)[number]
  | (typeof COMPONENT_EVENT_TYPES)[number]
  | (typeof FIXATION_EVENT_TYPES)[number]
  | (typeof POLICY_EVENT_TYPES)[number];

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

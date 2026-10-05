/** One event a machine-extracted schema suggestion believes a promotion candidate emits (`SchemaSuggestion.events` element). */
export interface SuggestedEvent {
  name: string;
  description: string;
}

/**
 * Wire shape of the `draft` a machine-extracted schema suggestion proposes. Structurally identical to
 * `@kohaku-ui/lineage`'s `ComponentDraft` (not imported: spec-core sits below lineage in the dependency
 * direction, so the shape is mirrored here — the same idiom `@kohaku-ui/client`'s own `ComponentDraft`
 * already uses for this wire contract).
 */
export interface SuggestedDraft {
  componentType: string;
  version: string;
  intentName: string;
  description: string;
  /** JSON Schema for the props (LLM-extracted or a human-entered draft). */
  paramsJsonSchema?: unknown;
  /** Data wiring for the promotion Intent: mapping of intent params -> query://. */
  queryTemplate?: {
    path: string;
    fixedParams?: Record<string, string>;
    paramMap?: Record<string, string>;
  };
}

/**
 * A machine-extracted registration proposal for a promotion candidate (advisory only; docs/design.md
 * §9.2 "Schema suggestion"). Produced by an extractor (`@kohaku-ui/evals`' `createSchemaExtractor`),
 * persisted on the promotion snapshot (`@kohaku-ui/lineage`'s `PromotionCandidate.suggestion`) so the
 * approval UI can prefill its form, and mirrored on the wire by `@kohaku-ui/client`'s
 * `SchemaSuggestionView`. Defined here, not in any one of those three packages, because it is a single
 * wire-contract type shared across same-layer packages that must not depend on one another (evals
 * produces it, lineage persists it, client mirrors it as a REST view) — the previous state had three
 * independently hand-maintained, structurally-identical definitions that could silently drift. Never
 * applied without a human `approve` carrying the final draft.
 */
export interface SchemaSuggestion {
  draft: SuggestedDraft;
  events: SuggestedEvent[];
  /** The extractor's own 0..1 estimate of how faithfully the proposal reflects the HTML. */
  confidence: number;
  /** The model that produced the proposal (LlmPort.modelId), for the audit trail. */
  model: string;
  /** Extractor identity + version, stamped like a rubric so a later prompt change is visible in lineage. */
  extractorId: string;
  extractorVersion: string;
  suggestedAt: string;
}

/**
 * The contribution of domain-specific components (a delta over the core catalog).
 * The concrete ComponentDefinition is owned by @kohaku-ui/registry (the generic parameter preserves the
 * dependency direction).
 */
export interface CatalogContribution<TDef = unknown> {
  components: TDef[];
}

import type { ComponentDraft, MachinePolicy, PromotionStatus } from "./machine.js";
import type { SchemaSuggestion } from "./suggestion.js";

export interface PromotionPolicy extends MachinePolicy {
  /** Threshold for candidacy (usage log -> candidate) */
  minUses: number;
  minDistinctSessions: number;
}

/**
 * Generation provenance carried from the candidate's `component.generated` lineage event: which
 * design kit and generator revision produced it, and (when known) which model. Read by the migration
 * planner (host-core's catalog-migration.ts / analyzeCatalogImpact) to flag a published candidate whose
 * `origin.kit` no longer matches the catalog's current kit.
 */
export interface PromotionOrigin {
  kit?: { id: string; version: string };
  generatorVersion?: string;
  model?: string;
}

export interface PromotionCandidate {
  artifactId: string;
  status: PromotionStatus;
  canonical?: string;
  request?: string;
  html?: string;
  /** The artifact body's sha256 (used for content verification at sandbox mount time). */
  sha256?: string;
  /** The data reference at generation time (data.$ref). Used to re-mount the preview and resolve its data. */
  ref?: string;
  uses: number;
  sessions: number;
  verdict?: unknown;
  draft?: ComponentDraft;
  /** Machine-extracted registration proposal (advisory; persisted on the snapshot as data.suggestion). */
  suggestion?: SchemaSuggestion;
  /** See PromotionOrigin. Kept across every transition once captured (unlike html/sha256/ref, which are
   * only copied onto the snapshot at publish time — origin is provenance, not a projection). */
  origin?: PromotionOrigin;
  updatedAt: string;
}

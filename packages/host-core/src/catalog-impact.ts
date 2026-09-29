import type { DeprecationDecl, ResolvedCatalog } from "@kohaku-ui/registry";
import type { FixationRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";

/**
 * Catalog-migration impact analysis (design.md #65). Read-only: nothing here writes to storage or the
 * catalog — it is the "what would break / what needs attention" report a migration is planned from
 * (catalog-migration.ts's planCatalogMigration consumes the same ResolvedCatalog to build an actual
 * rewrite plan; this module only surveys the current state).
 *
 * Four independent findings, each catching a different class of problem:
 * 1. fixationIssues — a fixed (L0) Spec that no longer structurally validates against the current
 *    catalog (component removed, or its props schema tightened incompatibly). Uses the same
 *    ResolvedCatalog.validate() @kohaku-ui/composer's materializeFixation calls on fingerprint mismatch,
 *    so "would this fixation still be deliverable" matches the real serving path exactly.
 * 2. deprecatedUsage — every catalog entry currently marked `deprecated`, and where it is still used
 *    (fixations by intentHash, promotion candidates of any status by artifactId) — advisory, since a
 *    deprecated part still validates (only generation stops offering it, registry/generation.ts).
 * 3. publishedPromotionIssues — a *published* promotion candidate whose registered componentType is
 *    either deprecated or has disappeared from the catalog entirely ("removed": the catalog and the
 *    promotion-state authority have drifted apart — a promoted component's catalog registration was
 *    dropped without withdrawing the promotion itself).
 * 4. originKitMismatches — a published candidate generated under a design kit other than `currentKit`
 *    (PromotionCandidate.origin.kit, generation provenance). Not necessarily broken, but a migration candidate: its markup
 *    may not match the kit's current class vocabulary.
 */

export interface CatalogFixationIssue {
  intentHash: string;
  tenant?: string;
  /** Formatted as "componentId: message", matching materializeFixation's own issue formatting. */
  issues: string[];
}

export interface CatalogDeprecatedUsageEntry {
  type: string;
  deprecated: DeprecationDecl;
  fixations: { intentHash: string; tenant?: string }[];
  promotions: { artifactId: string; tenant?: string; status: string }[];
}

export interface CatalogPublishedPromotionIssue {
  artifactId: string;
  tenant?: string;
  componentType: string;
  reason: "deprecated" | "removed";
  /** Present only when reason is "deprecated" (a "removed" type has no catalog entry to read it from). */
  deprecated?: DeprecationDecl;
}

export interface CatalogOriginKitMismatch {
  artifactId: string;
  tenant?: string;
  kit: { id: string; version: string };
  currentKit: { id: string; version: string };
}

export interface CatalogImpactReport {
  fixationIssues: CatalogFixationIssue[];
  deprecatedUsage: CatalogDeprecatedUsageEntry[];
  publishedPromotionIssues: CatalogPublishedPromotionIssue[];
  originKitMismatches: CatalogOriginKitMismatch[];
}

export interface AnalyzeCatalogImpactOptions {
  storage: StoragePort;
  /** Resolves the catalog to analyze against, per tenant (mirrors ComposeContext.catalogFor). */
  catalogFor: (tenant?: string) => ResolvedCatalog;
  /** Tenants to sweep. Omitted = a single tenant-neutral sweep (tenant: undefined) — a single-tenant deployment's default. */
  tenants?: readonly (string | undefined)[];
  /** The kit considered canonical right now, for originKitMismatches. Omitted = that check is skipped entirely. */
  currentKit?: { id: string; version: string };
}

/** Reads a promotion state's best-known componentType: the publish-time projection (data.componentType,
 * #9) when present, else the draft's own (data.draft.componentType) for a not-yet-published candidate. */
function componentTypeOf(state: PromotionState): string | undefined {
  const direct = state.data["componentType"];
  if (typeof direct === "string") return direct;
  const draft = state.data["draft"];
  if (draft != null && typeof draft === "object") {
    const componentType = (draft as Record<string, unknown>)["componentType"];
    if (typeof componentType === "string") return componentType;
  }
  return undefined;
}

/** Reads a promotion state's origin.kit (generation provenance), when present. */
function originKitOf(state: PromotionState): { id: string; version: string } | undefined {
  const origin = state.data["origin"];
  if (origin == null || typeof origin !== "object") return undefined;
  const kit = (origin as Record<string, unknown>)["kit"];
  if (kit == null || typeof kit !== "object") return undefined;
  const id = (kit as Record<string, unknown>)["id"];
  const version = (kit as Record<string, unknown>)["version"];
  if (typeof id !== "string" || typeof version !== "string") return undefined;
  return { id, version };
}

function fixationIssuesFor(catalog: ResolvedCatalog, fixation: FixationRecord): string[] {
  const { issues } = catalog.validate(fixation.pinnedSpec.components, fixation.pinnedSpec.events);
  return issues.map((i) => `${i.componentId}: ${i.message}`);
}

/**
 * Surveys the impact a catalog migration would have across one or more tenants: broken fixations,
 * deprecated-part usage (with where it's used), published promotions on a deprecated/removed part, and
 * published promotions whose generation kit no longer matches `currentKit`. Every list is empty rather
 * than omitted when nothing was found, so a caller can render "no issues" without a presence check.
 */
export async function analyzeCatalogImpact(
  options: AnalyzeCatalogImpactOptions,
): Promise<CatalogImpactReport> {
  const { storage, catalogFor, currentKit } = options;
  const tenants = options.tenants ?? [undefined];

  const fixationIssues: CatalogFixationIssue[] = [];
  const deprecatedByType = new Map<string, CatalogDeprecatedUsageEntry>();
  const publishedPromotionIssues: CatalogPublishedPromotionIssue[] = [];
  const originKitMismatches: CatalogOriginKitMismatch[] = [];

  for (const tenant of tenants) {
    const catalog = catalogFor(tenant);
    const deprecatedTypes = new Map(
      catalog
        .list()
        .filter((d) => d.deprecated != null)
        .map((d) => [d.type, d.deprecated!]),
    );

    const [fixations, promotions] = await Promise.all([
      storage.listFixations(tenant),
      storage.listPromotionStates(tenant),
    ]);

    for (const fixation of fixations) {
      const issues = fixationIssuesFor(catalog, fixation);
      if (issues.length > 0) {
        fixationIssues.push({
          intentHash: fixation.intentHash,
          ...(tenant != null ? { tenant } : {}),
          issues,
        });
      }
      for (const node of fixation.pinnedSpec.components) {
        const deprecated = deprecatedTypes.get(node.type);
        if (deprecated == null) continue;
        const entry = deprecatedByType.get(node.type) ?? {
          type: node.type,
          deprecated,
          fixations: [],
          promotions: [],
        };
        entry.fixations.push({ intentHash: fixation.intentHash, ...(tenant != null ? { tenant } : {}) });
        deprecatedByType.set(node.type, entry);
      }
    }

    for (const state of promotions) {
      const componentType = componentTypeOf(state);
      if (componentType == null) continue;

      const deprecated = deprecatedTypes.get(componentType);
      if (deprecated != null) {
        const entry = deprecatedByType.get(componentType) ?? {
          type: componentType,
          deprecated,
          fixations: [],
          promotions: [],
        };
        entry.promotions.push({
          artifactId: state.artifactId,
          ...(tenant != null ? { tenant } : {}),
          status: state.status,
        });
        deprecatedByType.set(componentType, entry);
      }

      if (state.status !== "published") continue;

      if (deprecated != null) {
        publishedPromotionIssues.push({
          artifactId: state.artifactId,
          ...(tenant != null ? { tenant } : {}),
          componentType,
          reason: "deprecated",
          deprecated,
        });
      } else if (catalog.get(componentType) == null) {
        publishedPromotionIssues.push({
          artifactId: state.artifactId,
          ...(tenant != null ? { tenant } : {}),
          componentType,
          reason: "removed",
        });
      }

      if (currentKit != null) {
        const kit = originKitOf(state);
        if (kit != null && (kit.id !== currentKit.id || kit.version !== currentKit.version)) {
          originKitMismatches.push({
            artifactId: state.artifactId,
            ...(tenant != null ? { tenant } : {}),
            kit,
            currentKit,
          });
        }
      }
    }
  }

  return {
    fixationIssues,
    deprecatedUsage: [...deprecatedByType.values()],
    publishedPromotionIssues,
    originKitMismatches,
  };
}

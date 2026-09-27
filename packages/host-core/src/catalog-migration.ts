import type { ResolvedCatalog } from "@kohaku-ui/registry";
import {
  type ComponentNode,
  canonicalStringify,
  computeStructureHash,
  type FixationRecord,
  type JsonObject,
  type Principal,
  type StoragePort,
  sha256Hex,
  type UISpec,
} from "@kohaku-ui/spec-core";

/**
 * Catalog migration: planning + applying a bulk rewrite of fixated (L0) Specs from a deprecated part onto
 * its replacement (design.md #65). Two-phase, mirroring the promotion pipeline's own separation of
 * "compute what would happen" from "commit it":
 *
 * - `planCatalogMigration` is read-only. For every deprecated catalog entry that declares `replacedBy`, it
 *   finds every fixation (per tenant) referencing that type, rewrites the matching nodes' `type` (and
 *   `version`, when `replacedBy.version` is pinned) and props (via the part's `migrateProps`, when
 *   declared), then revalidates the rewritten Spec against the *target* catalog with
 *   `ResolvedCatalog.validate` — the same check `@kohaku-ui/composer`'s `materializeFixation` runs on a
 *   fingerprint mismatch. A fixation that fails revalidation (an incompatible props shape, a capability the
 *   new type doesn't support, …) is reported in `blocked` instead of `steps`, never silently dropped.
 * - `applyCatalogMigration` commits a previously computed plan's `steps` through a host-supplied
 *   fixation-replace surface (structurally `@kohaku-ui/lineage`'s `Fixations.replace` — see
 *   `CatalogMigrationFixationReplacer`'s doc for why this is a structural interface rather than an import;
 *   host-core must not depend on lineage). Each step's `beforeStructureHash` / `beforeRevision` become a
 *   TOCTOU guard, so a fixation that moved on (re-approved, unfixated, or already migrated by a concurrent
 *   `apply`) since the plan was built is skipped rather than clobbered.
 */

export interface CatalogMigrationRewrite {
  /** The deprecated type being migrated away from. */
  from: string;
  /** The replacement type (and, when the catalog's `replacedBy.version` is pinned, its exact version). */
  to: { type: string; version?: string };
}

export interface CatalogMigrationStep {
  intentHash: string;
  tenant?: string;
  /** The fixation's structureHash / revision / fixatedAt as observed while planning — applyCatalogMigration's TOCTOU guard. */
  beforeStructureHash: string;
  beforeRevision?: string;
  beforeFixatedAt: string;
  /** The rewritten Spec: matching nodes' type/version/props replaced, already revalidated against the target catalog. */
  pinnedSpec: UISpec;
  afterStructureHash: string;
  /** ids of the nodes actually rewritten (for a human-readable diff / CLI summary). */
  rewrittenNodeIds: string[];
}

export interface CatalogMigrationBlocked {
  intentHash: string;
  tenant?: string;
  /** The type(s) that would have been rewritten, had revalidation not failed. */
  types: string[];
  /** Formatted as "componentId: message", matching materializeFixation's own issue formatting. */
  issues: string[];
}

export interface CatalogMigrationPlan {
  /**
   * Deterministic hash over every step's identifying fields (never the full pinnedSpec — see
   * `computePlanHash`). Recorded on `intent.migrated` as `planId` so an applied migration's audit trail
   * traces back to the exact plan that produced it, and lets a caller detect that re-planning would produce
   * a different result before re-running `applyCatalogMigration` against a stale plan.json.
   */
  planHash: string;
  rewrites: CatalogMigrationRewrite[];
  steps: CatalogMigrationStep[];
  blocked: CatalogMigrationBlocked[];
}

export interface PlanCatalogMigrationOptions {
  storage: StoragePort;
  /** Resolves the catalog to plan and revalidate against, per tenant (mirrors ComposeContext.catalogFor). */
  catalogFor: (tenant?: string) => ResolvedCatalog;
  /** Tenants to sweep. Omitted = a single tenant-neutral sweep (tenant: undefined). */
  tenants?: readonly (string | undefined)[];
  /**
   * Restricts planning to these deprecated types. Omitted = every catalog entry that is both `deprecated`
   * and declares `replacedBy` (a deprecated entry with no `replacedBy` has nothing to migrate *to* and is
   * never planned against, regardless of this option).
   */
  types?: readonly string[];
}

function rewriteNode(
  node: ComponentNode,
  to: { type: string; version?: string },
  migrateProps?: (props: JsonObject) => JsonObject,
): ComponentNode {
  return {
    ...node,
    type: to.type,
    version: to.version,
    props: migrateProps != null ? migrateProps(node.props) : node.props,
  };
}

/** Canonical, content-addressed hash over a plan's identifying fields (excludes the full pinnedSpec of each
 * step — only the before/after structure hashes and which nodes moved, so the hash is stable across a
 * cosmetically-different but semantically-identical rewrite and cheap to recompute for comparison). */
async function computePlanHash(
  rewrites: CatalogMigrationRewrite[],
  steps: CatalogMigrationStep[],
  blocked: CatalogMigrationBlocked[],
): Promise<string> {
  const material = {
    rewrites,
    steps: steps
      .map((s) => ({
        intentHash: s.intentHash,
        tenant: s.tenant,
        beforeStructureHash: s.beforeStructureHash,
        afterStructureHash: s.afterStructureHash,
        rewrittenNodeIds: [...s.rewrittenNodeIds].sort(),
      }))
      .sort((a, b) => (a.intentHash < b.intentHash ? -1 : a.intentHash > b.intentHash ? 1 : 0)),
    blocked: blocked
      .map((b) => ({ intentHash: b.intentHash, tenant: b.tenant, types: [...b.types].sort() }))
      .sort((a, b) => (a.intentHash < b.intentHash ? -1 : a.intentHash > b.intentHash ? 1 : 0)),
  };
  return `sha256:${await sha256Hex(canonicalStringify(material))}`;
}

/**
 * Surveys every tenant's fixations for uses of a deprecated-with-replacement catalog type, rewrites them,
 * and revalidates the result. Read-only: nothing is written to storage. See the module doc for the
 * plan/apply split.
 */
export async function planCatalogMigration(
  options: PlanCatalogMigrationOptions,
): Promise<CatalogMigrationPlan> {
  const { storage, catalogFor } = options;
  const tenants = options.tenants ?? [undefined];

  const rewriteByType = new Map<string, CatalogMigrationRewrite>();
  const steps: CatalogMigrationStep[] = [];
  const blocked: CatalogMigrationBlocked[] = [];

  for (const tenant of tenants) {
    const catalog = catalogFor(tenant);
    const migrationMap = new Map<
      string,
      { to: { type: string; version?: string }; migrateProps?: (props: JsonObject) => JsonObject }
    >();
    for (const def of catalog.list()) {
      const replacedBy = def.deprecated?.replacedBy;
      if (replacedBy == null) continue;
      if (options.types != null && !options.types.includes(def.type)) continue;
      migrationMap.set(def.type, { to: replacedBy, migrateProps: def.migrateProps });
      if (!rewriteByType.has(def.type)) {
        rewriteByType.set(def.type, { from: def.type, to: replacedBy });
      }
    }
    if (migrationMap.size === 0) continue;

    const fixations = await storage.listFixations(tenant);
    for (const fixation of fixations) {
      const rewrittenNodeIds: string[] = [];
      const types = new Set<string>();
      const rewrittenComponents = fixation.pinnedSpec.components.map((node) => {
        const rewrite = migrationMap.get(node.type);
        if (rewrite == null) return node;
        rewrittenNodeIds.push(node.id);
        types.add(node.type);
        return rewriteNode(node, rewrite.to, rewrite.migrateProps);
      });
      if (rewrittenNodeIds.length === 0) continue; // this fixation does not reference any migrated type

      const newPinnedSpec: UISpec = { ...fixation.pinnedSpec, components: rewrittenComponents };
      const { issues } = catalog.validate(newPinnedSpec.components, newPinnedSpec.events);
      if (issues.length > 0) {
        blocked.push({
          intentHash: fixation.intentHash,
          ...(tenant != null ? { tenant } : {}),
          types: [...types],
          issues: issues.map((i) => `${i.componentId}: ${i.message}`),
        });
        continue;
      }

      steps.push({
        intentHash: fixation.intentHash,
        ...(tenant != null ? { tenant } : {}),
        beforeStructureHash: fixation.structureHash,
        ...(fixation.revision != null ? { beforeRevision: fixation.revision } : {}),
        beforeFixatedAt: fixation.fixatedAt,
        pinnedSpec: newPinnedSpec,
        afterStructureHash: await computeStructureHash(newPinnedSpec),
        rewrittenNodeIds,
      });
    }
  }

  const rewrites = [...rewriteByType.values()];
  return { planHash: await computePlanHash(rewrites, steps, blocked), rewrites, steps, blocked };
}

/**
 * Structural counterpart of `@kohaku-ui/lineage`'s `Fixations.replace` — declared locally (rather than
 * imported) because host-core must not depend on lineage (dependency direction; lineage sits one layer
 * above host-core). The concrete `Fixations` class satisfies this shape as-is, the same relationship
 * `fixation.ts`'s `FixationSelfHealApi` / `FixationDeliveryHost` already have with it.
 */
export interface CatalogMigrationFixationReplacer {
  replace(
    intentHash: string,
    pinnedSpec: UISpec,
    options: {
      approver: Principal;
      tenant?: string;
      guard?: { ifRevision?: string; ifFixatedAt?: string; ifStructureHash?: string };
      planId?: string;
    },
  ): Promise<FixationRecord | null>;
}

export interface ApplyCatalogMigrationOptions {
  plan: CatalogMigrationPlan;
  fixations: CatalogMigrationFixationReplacer;
  approver: Principal;
}

export interface CatalogMigrationApplyResult {
  applied: { intentHash: string; tenant?: string }[];
  /**
   * A planned step whose guard did not match at apply time — the fixation was unfixated, re-approved, or
   * already migrated by a concurrent `apply` since the plan was built (TOCTOU; `Fixations.replace` returns
   * `null` for either cause without distinguishing them, so neither does this).
   */
  skipped: { intentHash: string; tenant?: string }[];
}

/**
 * Commits a plan's `steps` (never `blocked` — those need a person to resolve the revalidation failure
 * first, typically by re-planning after fixing the part's `migrateProps` or its propsSchema). Each
 * `Fixations.replace` call is independently guarded by that step's own `beforeStructureHash` /
 * `beforeRevision` / `beforeFixatedAt`, so applying a plan is safe to run even if some fixations changed
 * underneath it since planning — those are reported in `skipped`, not applied over.
 */
export async function applyCatalogMigration(
  options: ApplyCatalogMigrationOptions,
): Promise<CatalogMigrationApplyResult> {
  const { plan, fixations, approver } = options;
  const applied: CatalogMigrationApplyResult["applied"] = [];
  const skipped: CatalogMigrationApplyResult["skipped"] = [];

  for (const step of plan.steps) {
    const result = await fixations.replace(step.intentHash, step.pinnedSpec, {
      approver,
      ...(step.tenant != null ? { tenant: step.tenant } : {}),
      guard: {
        ...(step.beforeRevision != null ? { ifRevision: step.beforeRevision } : {}),
        ifFixatedAt: step.beforeFixatedAt,
        ifStructureHash: step.beforeStructureHash,
      },
      planId: plan.planHash,
    });
    if (result == null) {
      skipped.push({ intentHash: step.intentHash, ...(step.tenant != null ? { tenant: step.tenant } : {}) });
    } else {
      applied.push({ intentHash: step.intentHash, ...(step.tenant != null ? { tenant: step.tenant } : {}) });
    }
  }

  return { applied, skipped };
}

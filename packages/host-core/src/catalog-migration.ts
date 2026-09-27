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
 *   host-core must not depend on lineage). Each step's `beforeStructureHash` / `beforeRevision` /
 *   `beforeFixatedAt` / `beforeCatalogFingerprint` become a TOCTOU guard on the *fixation*, so a fixation
 *   that moved on (re-approved, unfixated, or already migrated by a concurrent `apply`) since the plan was
 *   built is skipped rather than clobbered. Independently, each step is also checked against the *catalog*
 *   itself (`ApplyCatalogMigrationOptions.catalogFor`, required): its `targetCatalogFingerprint` must match
 *   the live catalog's fingerprint, and the rewritten `pinnedSpec` is re-`validate`d against it unconditionally
 *   (not only on a fingerprint mismatch — a propsSchema tightened without a version bump changes neither
 *   fingerprint nor structureHash) before anything is written; either failing reports the step in `blocked`
 *   with `reason: "catalog-drift"` instead of applying it.
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
  /**
   * The fixation record's own `catalogFingerprint` field as observed while planning (absent for a legacy
   * fixation that predates the field). Passed to `Fixations.replace` as `guard.ifCatalogFingerprint` —
   * refuses the write if the fixation's own recorded fingerprint moved (e.g. a concurrent self-heal
   * re-stamp) since planning. Distinct from `targetCatalogFingerprint` below, which guards the *catalog's*
   * own fingerprint rather than this fixation record's.
   */
  beforeCatalogFingerprint?: string;
  /**
   * The tenant's catalog fingerprint as observed while planning (`catalogFor(tenant).fingerprint`).
   * `applyCatalogMigration` re-resolves the live catalog for this step's tenant and refuses to write the
   * step (reporting it in the apply result's `blocked`) if the live fingerprint differs — the catalog
   * itself may have changed (a part added/removed/further deprecated) since the plan was computed, and a
   * plan is not automatically safe to apply just because each individual fixation hasn't moved.
   */
  targetCatalogFingerprint: string;
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
        targetCatalogFingerprint: s.targetCatalogFingerprint,
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
 * Recomputes `plan.planHash` from the plan's own `rewrites` / `steps` / `blocked` and compares it against
 * the stored value — detects a hand-edited or otherwise corrupted plan (e.g. a `plan.json` round-tripped
 * through an external tool that altered a step's `pinnedSpec` without updating its `afterStructureHash`,
 * or `planHash` itself) before `applyCatalogMigration` ever calls `Fixations.replace`. This is a narrower,
 * cheaper check than re-running `planCatalogMigration` from scratch (it does not need a `catalogFor` or
 * `storage`, so it is available to `apply` even though `apply`'s own options carry neither) — it does not
 * (and cannot, without recomposing) detect that the *catalog itself* has since changed; the per-step TOCTOU
 * guard `applyCatalogMigration` already runs against live storage is what catches that.
 */
export async function verifyCatalogMigrationPlan(plan: CatalogMigrationPlan): Promise<boolean> {
  return (await computePlanHash(plan.rewrites, plan.steps, plan.blocked)) === plan.planHash;
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
        ...(fixation.catalogFingerprint != null
          ? { beforeCatalogFingerprint: fixation.catalogFingerprint }
          : {}),
        targetCatalogFingerprint: catalog.fingerprint,
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
      guard?: {
        ifRevision?: string;
        ifFixatedAt?: string;
        ifStructureHash?: string;
        ifCatalogFingerprint?: string;
      };
      planId?: string;
    },
  ): Promise<FixationRecord | null>;
}

export interface ApplyCatalogMigrationOptions {
  plan: CatalogMigrationPlan;
  fixations: CatalogMigrationFixationReplacer;
  approver: Principal;
  /**
   * Resolves the *live* catalog per tenant, checked against each step's `targetCatalogFingerprint` before
   * anything is written. Required (not optional) so a stale `plan.json` can never be applied blind against
   * a catalog that has since diverged from what the plan assumed — a plan is a point-in-time computation,
   * not a guarantee that stays valid until someone gets around to applying it.
   */
  catalogFor: (tenant?: string) => ResolvedCatalog;
}

export interface CatalogMigrationApplyBlocked {
  intentHash: string;
  tenant?: string;
  reason: "catalog-drift";
  /** The live catalog's fingerprint actually observed at apply time (compare against the plan's own `steps[].targetCatalogFingerprint`). */
  observedCatalogFingerprint: string;
  /**
   * Issues from re-validating `pinnedSpec` against the live catalog (`ResolvedCatalog.validate`), formatted
   * as `materializeFixation` formats them. Empty when only the fingerprint differed but the pinnedSpec
   * still happens to validate against the live catalog — still refused, since the plan was computed against
   * a catalog that is no longer the one being applied against, not because this specific rewrite is known
   * to be broken. Non-empty catches a case fingerprint comparison alone cannot: a part's propsSchema
   * tightened in place without a version bump does not change the catalog fingerprint at all (the
   * fingerprint is derived from `type@version`, not props content), so this check runs unconditionally,
   * never only when the fingerprint already differed.
   */
  issues: string[];
}

export interface CatalogMigrationApplyResult {
  applied: { intentHash: string; tenant?: string }[];
  /**
   * A planned step whose guard did not match at apply time — the fixation was unfixated, re-approved, or
   * already migrated by a concurrent `apply` since the plan was built (TOCTOU; `Fixations.replace` returns
   * `null` for either cause without distinguishing them, so neither does this).
   */
  skipped: { intentHash: string; tenant?: string }[];
  /**
   * A planned step refused because the *catalog* (not the fixation) moved since planning — see
   * `CatalogMigrationApplyBlocked`. Nothing is written for a blocked step; `Fixations.replace` is never
   * called for it.
   */
  blocked: CatalogMigrationApplyBlocked[];
}

/**
 * Commits a plan's `steps` (never `plan.blocked` — those need a person to resolve the revalidation failure
 * first, typically by re-planning after fixing the part's `migrateProps` or its propsSchema). Each
 * `Fixations.replace` call is independently guarded by that step's own `beforeStructureHash` /
 * `beforeRevision` / `beforeFixatedAt` / `beforeCatalogFingerprint`, so applying a plan is safe to run even
 * if some fixations changed underneath it since planning — those are reported in `skipped`, not applied
 * over. Before that per-fixation guard is even reached, each step is independently re-checked against the
 * *live* catalog (fingerprint match, then a full re-`validate`) — a step whose target catalog has drifted
 * since planning is reported in `blocked` instead, and nothing is written for it.
 */
export async function applyCatalogMigration(
  options: ApplyCatalogMigrationOptions,
): Promise<CatalogMigrationApplyResult> {
  const { plan, fixations, approver, catalogFor } = options;
  const applied: CatalogMigrationApplyResult["applied"] = [];
  const skipped: CatalogMigrationApplyResult["skipped"] = [];
  const blocked: CatalogMigrationApplyResult["blocked"] = [];

  for (const step of plan.steps) {
    const catalog = catalogFor(step.tenant);
    // Always re-validate, not only on a fingerprint mismatch: a propsSchema tightened in place under the
    // same type@version never changes the fingerprint at all, so validation is the only thing that catches it.
    const { issues } = catalog.validate(step.pinnedSpec.components, step.pinnedSpec.events);
    if (catalog.fingerprint !== step.targetCatalogFingerprint || issues.length > 0) {
      blocked.push({
        intentHash: step.intentHash,
        ...(step.tenant != null ? { tenant: step.tenant } : {}),
        reason: "catalog-drift",
        observedCatalogFingerprint: catalog.fingerprint,
        issues: issues.map((i) => `${i.componentId}: ${i.message}`),
      });
      continue;
    }

    const result = await fixations.replace(step.intentHash, step.pinnedSpec, {
      approver,
      ...(step.tenant != null ? { tenant: step.tenant } : {}),
      guard: {
        ...(step.beforeRevision != null ? { ifRevision: step.beforeRevision } : {}),
        ifFixatedAt: step.beforeFixatedAt,
        ifStructureHash: step.beforeStructureHash,
        ...(step.beforeCatalogFingerprint != null
          ? { ifCatalogFingerprint: step.beforeCatalogFingerprint }
          : {}),
      },
      planId: plan.planHash,
    });
    if (result == null) {
      skipped.push({ intentHash: step.intentHash, ...(step.tenant != null ? { tenant: step.tenant } : {}) });
    } else {
      applied.push({ intentHash: step.intentHash, ...(step.tenant != null ? { tenant: step.tenant } : {}) });
    }
  }

  return { applied, skipped, blocked };
}

import type { ResolvedCatalog } from "./catalog.js";

/**
 * Options for stagedCatalogFor: a canary rollout of one catalog version onto another (design.md #65).
 * `stable` and `next` are each already-resolved (`resolveCatalog(coreCatalog, ...)`), so a product
 * migrating a deprecated part to its replacement can compute `next` once (the catalog after the
 * migration) and stage it in behind `inRollout` before flipping every tenant over.
 */
export interface StagedCatalogOptions {
  /** Served to every tenant not in the rollout, and always served for tenant-neutral traffic (see stagedCatalogFor's doc). */
  stable: ResolvedCatalog;
  /** Served only to a tenant `inRollout` admits. */
  next: ResolvedCatalog;
  /** Decides per tenant whether `next` applies. Never consulted for tenant-neutral traffic (tenant undefined always resolves to `stable`). */
  inRollout: (tenant: string) => boolean;
}

/**
 * Builds a `(tenant?: string) => ResolvedCatalog` — the same shape `ComposeContext.catalogFor` and
 * `Fixations`' own `catalogFor` option already take — that serves `next` only to tenants `inRollout`
 * admits, `stable` to everyone else.
 *
 * Tenant-neutral traffic (no tenant resolved at all) always gets `stable`, unconditionally: a canary
 * rollout is staged in tenant by tenant, and a deployment with no tenant resolution has no rollout list to
 * consult in the first place, so it must never be silently opted in.
 *
 * Layering with promotions: this function only chooses between the two given *bases* — it does not itself
 * merge in a per-tenant promoted-component contribution the way a product's own catalog resolution (e.g.
 * `resolveCatalog(coreCatalog, productContribution, { components: promotedEntries })`) does. A product that
 * also promotes components per tenant applies that layering *after* `stagedCatalogFor` has picked the base:
 * build `stable` and `next` as `resolveCatalog(coreCatalog, ...)` results that already carry the tenant's
 * promoted entries, or wrap this function's result with the product's own promotion merge.
 */
export function stagedCatalogFor(options: StagedCatalogOptions): (tenant?: string) => ResolvedCatalog {
  const { stable, next, inRollout } = options;
  return (tenant?: string): ResolvedCatalog => {
    if (tenant == null) return stable;
    return inRollout(tenant) ? next : stable;
  };
}

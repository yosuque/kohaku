import type { ResolvedCatalog } from "@kohaku-ui/registry";
import { describe, expect, it, vi } from "vitest";
import { PromotedRegistry } from "../src/intents/promoted-registry.js";

// PromotedRegistry.componentCatalogFor / intentCatalogFor cache per-tenant catalogs indefinitely (tenants
// are assumed bounded — a fixed/small set), but a long-lived process must not grow those caches without
// bound if that assumption is ever violated (e.g. a per-request synthetic tenant id). These tests exercise
// the eviction guard (same "clear everything, key space is bounded and rarely reached" policy as
// registry/src/negotiate.ts's satisfiesCache) without depending on its exact internal threshold value.

function fakeBuildComponentCatalog(): ResolvedCatalog {
  return { fingerprint: `fp-${Math.random()}` } as unknown as ResolvedCatalog;
}

describe("PromotedRegistry: tenant catalog cache cap", () => {
  it('clears cached tenant component catalogs (except the default "" bucket) once the cache reaches its threshold', () => {
    const buildComponentCatalog = vi.fn(fakeBuildComponentCatalog);
    const registry = new PromotedRegistry(buildComponentCatalog, new Set());

    const defaultCatalog = registry.componentCatalogFor(undefined);
    expect(buildComponentCatalog).toHaveBeenCalledTimes(1);

    // Well past any reasonable internal cap, so at least one eviction is guaranteed to occur.
    const TENANTS = 80;
    for (let i = 0; i < TENANTS; i++) registry.componentCatalogFor(`tenant-${i}`);
    expect(buildComponentCatalog).toHaveBeenCalledTimes(TENANTS + 1);

    // The default bucket is never evicted: re-fetching it does not rebuild.
    expect(registry.componentCatalogFor(undefined)).toBe(defaultCatalog);
    expect(buildComponentCatalog).toHaveBeenCalledTimes(TENANTS + 1);

    // tenant-0 was cached early; since the cache was cleared at least once while filling to TENANTS, it
    // must have been evicted along the way -- fetching it again rebuilds (one extra call).
    const callsBefore = buildComponentCatalog.mock.calls.length;
    registry.componentCatalogFor("tenant-0");
    expect(buildComponentCatalog.mock.calls.length).toBe(callsBefore + 1);
  });

  it("clears intentCatalogs in tandem with componentCatalogs (both track the same tenant key set)", () => {
    const registry = new PromotedRegistry(fakeBuildComponentCatalog, new Set());

    const defaultIntentCatalog = registry.intentCatalogFor(undefined);
    const firstTenantIntentCatalog = registry.intentCatalogFor("tenant-0");

    // Drive componentCatalogs.size past the cap via unrelated tenants.
    for (let i = 1; i < 80; i++) registry.componentCatalogFor(`tenant-${i}`);

    // tenant-0's intent catalog was cleared alongside the component-catalog eviction: a fresh instance is
    // built now (reference identity differs).
    expect(registry.intentCatalogFor("tenant-0")).not.toBe(firstTenantIntentCatalog);
    // The default bucket's intent catalog survives the clear.
    expect(registry.intentCatalogFor(undefined)).toBe(defaultIntentCatalog);
  });
});

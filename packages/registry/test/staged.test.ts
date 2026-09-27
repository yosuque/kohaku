import { describe, expect, it } from "vitest";
import { coreCatalog, resolveCatalog, stagedCatalogFor } from "../src/index.js";

const stable = resolveCatalog(coreCatalog);
const next = resolveCatalog(coreCatalog); // a distinct ResolvedCatalog instance stands in for "the migrated catalog"

describe("stagedCatalogFor", () => {
  it("tenant-neutral traffic (tenant undefined) always resolves to stable, even if inRollout(undefined) would admit it", () => {
    const catalogFor = stagedCatalogFor({ stable, next, inRollout: () => true });
    expect(catalogFor(undefined)).toBe(stable);
  });

  it("a tenant admitted by inRollout gets next", () => {
    const catalogFor = stagedCatalogFor({ stable, next, inRollout: (tenant) => tenant === "acme" });
    expect(catalogFor("acme")).toBe(next);
  });

  it("a tenant not admitted by inRollout gets stable", () => {
    const catalogFor = stagedCatalogFor({ stable, next, inRollout: (tenant) => tenant === "acme" });
    expect(catalogFor("globex")).toBe(stable);
  });

  it("inRollout is never called for tenant-neutral traffic", () => {
    let called = false;
    const catalogFor = stagedCatalogFor({
      stable,
      next,
      inRollout: () => {
        called = true;
        return true;
      },
    });
    catalogFor(undefined);
    expect(called).toBe(false);
  });
});

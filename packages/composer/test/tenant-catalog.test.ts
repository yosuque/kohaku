import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { CanonicalIntent, GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { compose } from "../src/compose.js";
import type { ComposeContext } from "../src/context.js";
import { withTenantCatalog } from "../src/context.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage, REF } from "./helpers.js";

/**
 * #1: Per-tenant catalog resolution. When ComposeContext.catalogFor is passed, compose does generation and
 * cache-key computation with session.tenant's catalog (the fingerprint changes per tenant, so the cache separates naturally).
 */

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "view.select",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

/** A catalog with only the fingerprint swapped (a model of a per-tenant catalog). */
function catalogWithFingerprint(fp: string) {
  return { ...catalog, fingerprint: fp } as typeof catalog;
}

describe("withTenantCatalog", () => {
  it("when catalogFor is not wired, returns ctx as-is (backward compatible, no transformation)", () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [] }),
    };
    expect(withTenantCatalog(ctx, "t1")).toBe(ctx);
  });

  it("when catalogFor is wired, swaps in the tenant's catalog (preserves the storage reference)", () => {
    const storage = makeStorage();
    const ctx: ComposeContext = {
      catalog,
      catalogFor: (tenant) => catalogWithFingerprint(`fp-${tenant ?? "base"}`),
      semantic: makeSemantic(),
      storage,
      llm: new FakeLlm({ objects: [] }),
    };
    const forA = withTenantCatalog(ctx, "tenant-a");
    expect(forA.catalog.fingerprint).toBe("fp-tenant-a");
    // Because the single-flight in-flight table is keyed by storage, keep the same reference even after the swap.
    expect(forA.storage).toBe(storage);
  });
});

describe("compose per-tenant catalog", () => {
  it("different tenants' catalog fingerprints separate the cache keys (B does not hit A's output)", async () => {
    const storage = makeStorage();
    const ctx: ComposeContext = {
      catalog,
      catalogFor: (tenant) => catalogWithFingerprint(`fp-${tenant ?? "base"}`),
      semantic: makeSemantic(),
      storage,
      llm: new FakeLlm({ objects: [goodRawDraft(), goodRawDraft(), goodRawDraft()] }),
    };

    const a1 = await compose(GUI_INPUT, ctx, { session: { surface: "web", tenant: "tenant-a" } });
    expect(a1.spec.provenance.cache).toBe("miss");

    // A different tenant (a different catalog fingerprint) is a miss even for the same intent (does not ride along on A's cache).
    const b1 = await compose(GUI_INPUT, ctx, { session: { surface: "web", tenant: "tenant-b" } });
    expect(b1.spec.provenance.cache).toBe("miss");

    // A re-compose of the same tenant A is a hit (the cache works within a tenant).
    const a2 = await compose(GUI_INPUT, ctx, { session: { surface: "web", tenant: "tenant-a" } });
    expect(a2.spec.provenance.cache).toBe("hit");

    // There are only 2 cache keys (A and B) (A's second time is the same key).
    expect(storage.specCache.size).toBe(2);
  });

  it("session.tenant propagates to resolveQuery (resolution of per-tenant promoted Intents)", async () => {
    const seenTenants: (string | undefined)[] = [];
    const semantic = makeSemantic();
    const trackingSemantic = {
      ...semantic,
      async resolveQuery(intent: CanonicalIntent, resolveCtx?: { tenant?: string }) {
        seenTenants.push(resolveCtx?.tenant);
        return semantic.resolveQuery(intent, resolveCtx);
      },
    };
    const ctx: ComposeContext = {
      catalog,
      semantic: trackingSemantic,
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft(REF)] }),
    };

    await compose(GUI_INPUT, ctx, { session: { surface: "web", tenant: "tenant-x" } });
    expect(seenTenants).toContain("tenant-x");
  });
});

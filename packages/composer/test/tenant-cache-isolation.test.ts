import { FakeLlm } from "@kohaku-ui/llm/fake";
import { type GuiAction, SANDBOX_HTML_TYPE } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

const L2_HTML =
  "<!DOCTYPE html><html><head><title>Sales widget</title></head><body><script>window.kohaku.ready()</script></body></html>";

/**
 * Regression coverage for SPEC CMP-DET-002 ("a cache entry only reachable via L2 MUST NOT be returned to
 * a session that has L2 disabled") -- the invariant the tierGate policyFingerprint row (context.ts, task
 * 4) exists to guarantee. `tenant` itself is never part of the cache key (SPEC §6.1: `query://` is
 * tenant-neutral) -- before this row existed, `allowL2` was not part of the key either, so two sessions
 * differing only in `allowL2` for the identical intent/dataVersion/catalogFingerprint would collide on
 * the same Spec-cache entry.
 */
describe("tenant cache isolation (SPEC CMP-DET-002)", () => {
  it("a tenant whose policy disallows L2 never receives another tenant's cached L2 Spec for the same intent", async () => {
    // Same storage (Spec cache) is shared by both tenants on purpose -- this is exactly the scenario a
    // real host is in: one Spec cache, `tenant` narrowed only via DomainPort/capability (§2.3/§5), never
    // via the cache key.
    const storage = makeStorage();
    const semantic = makeSemantic();

    // tenant-b: allowL2 true, routed straight to L2.
    const tenantB: ComposeContext = {
      catalog,
      semantic,
      storage,
      llm: new FakeLlm({ texts: [L2_HTML] }),
      policy: { allowL2: true, routeTier: () => "L2" },
    };
    const resultB = await compose(GUI_INPUT, tenantB, { session: { surface: "web", tenant: "tenant-b" } });
    expect(resultB.trace.tier).toBe("L2");
    expect(resultB.spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(true);

    // tenant-a: allowL2 false, the SAME intent otherwise, sharing the SAME storage/Spec cache.
    const tenantA: ComposeContext = {
      catalog,
      semantic,
      storage,
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: { allowL2: false },
    };
    const resultA = await compose(GUI_INPUT, tenantA, { session: { surface: "web", tenant: "tenant-a" } });

    // Must NOT be a cache hit against tenant-b's L2 entry: distinct cache keys (the tierGate fingerprint
    // differs), a genuine L1 generation actually ran, and the delivered Spec carries no L2 component.
    expect(resultA.trace.cacheKey).not.toBe(resultB.trace.cacheKey);
    expect(resultA.trace.cache).toBe("miss");
    expect(resultA.trace.tier).toBe("L1");
    expect(resultA.spec.components.some((c) => c.type === SANDBOX_HTML_TYPE)).toBe(false);
  });

  it("two tenants with the identical effective tier-gate shape DO share a cache entry (isolation is not over-broad)", async () => {
    // The fingerprint separates on POLICY shape, not on `tenant` itself (tenant is never part of the
    // cache key -- SPEC §6.1): two tenants that both allow L2 legitimately keep the identical-display
    // cache-hit guarantee (CMP-DET-001) for the same intent.
    const storage = makeStorage();
    const semantic = makeSemantic();
    const policy: ComposeContext["policy"] = { allowL2: true, routeTier: () => "L2" as const };

    const first = await compose(
      GUI_INPUT,
      { catalog, semantic, storage, llm: new FakeLlm({ texts: [L2_HTML] }), policy },
      { session: { surface: "web", tenant: "tenant-b" } },
    );
    expect(first.trace.cache).toBe("miss");

    const second = await compose(
      GUI_INPUT,
      { catalog, semantic, storage, llm: new FakeLlm({ texts: [L2_HTML] }), policy },
      { session: { surface: "web", tenant: "tenant-c" } },
    );
    expect(second.trace.cache).toBe("hit");
    expect(second.trace.cacheKey).toBe(first.trace.cacheKey);
  });
});

import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { cacheKey, SPEC_VERSION } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, compose } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

describe("ComposeTrace.cacheKeyParts", () => {
  it("carries the exact components cacheKey was built from, on a cache miss", async () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    const result = await compose(GUI_INPUT, ctx);
    const { cacheKeyParts } = result.trace;
    expect(cacheKeyParts.intentHash).toBe(result.trace.intent.hash);
    expect(cacheKeyParts.dataVersion).toBe(result.trace.dataVersion);
    expect(cacheKeyParts.catalogFingerprint).toBe(catalog.fingerprint);
    // Regression: specVersion was previously left unset on the recorded parts even though cacheKey()
    // always falls back to SPEC_VERSION internally when building the key string -- so `kohaku explain`/
    // DevTools showed a "-" placeholder for a component that had in fact contributed a real segment.
    expect(cacheKeyParts.specVersion).toBe(SPEC_VERSION);
    // cacheKey() applied to the recorded parts reproduces the recorded cacheKey exactly (parts are not
    // just "some values that happened to be relevant" -- they are the literal input to cacheKey()).
    expect(cacheKey(cacheKeyParts)).toBe(result.trace.cacheKey);
  });

  it("carries every component cacheKey() reads, and rebuilding from them reproduces the recorded key", async () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: { generatorVersion: "gen-2", outputLanguage: "Japanese" },
    };
    const result = await compose(GUI_INPUT, ctx);
    const { cacheKeyParts } = result.trace;
    expect(cacheKeyParts.intentHash).toBeTruthy();
    expect(cacheKeyParts.dataVersion).toBeTruthy();
    expect(cacheKeyParts.catalogFingerprint).toBeTruthy();
    expect(cacheKeyParts.specVersion).toBeTruthy();
    expect(cacheKeyParts.generatorVersion).toBeTruthy();
    expect(cacheKeyParts.policyFingerprint).toBeTruthy();
    expect(cacheKey(cacheKeyParts)).toBe(result.trace.cacheKey);
  });

  it("is unchanged on a cache hit (the second compose's parts describe the same key as the first)", async () => {
    const storage = makeStorage();
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: {},
    };
    const first = await compose(GUI_INPUT, ctx);
    const second = await compose(GUI_INPUT, { ...ctx, llm: new FakeLlm({ objects: [goodRawDraft()] }) });
    expect(second.trace.cache).toBe("hit");
    expect(second.trace.cacheKeyParts).toEqual(first.trace.cacheKeyParts);
    expect(cacheKey(second.trace.cacheKeyParts)).toBe(second.trace.cacheKey);
  });

  it("includes generatorVersion and policyFingerprint only when the policy sets them", async () => {
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: { generatorVersion: "gen-2", outputLanguage: "Japanese" },
    };
    const result = await compose(GUI_INPUT, ctx);
    expect(result.trace.cacheKeyParts.generatorVersion).toBe("gen-2");
    expect(result.trace.cacheKeyParts.policyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(cacheKey(result.trace.cacheKeyParts)).toBe(result.trace.cacheKey);
  });
});

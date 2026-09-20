import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  type ComposeContext,
  type ComposePolicy,
  compose,
  DEFAULT_KIT_VOCABULARY,
  type DesignKitVocabulary,
  policyFingerprint,
} from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

function makeCtx(policy: ComposePolicy): ComposeContext {
  return {
    catalog,
    semantic: makeSemantic(),
    storage: makeStorage(),
    llm: new FakeLlm({ objects: [goodRawDraft()] }),
    policy,
  };
}

describe("policyFingerprint", () => {
  it("returns the empty string for a policy that sets none of the fingerprinted fields", async () => {
    expect(await policyFingerprint({})).toBe("");
    expect(await policyFingerprint({ cacheMode: "bypass", allowL2: true, maxRepairAttempts: 2 })).toBe("");
  });

  it('refConstraint: the empty string is preserved when unset or explicitly set to the default "schema" (no cache-key perturbation for existing callers)', async () => {
    expect(await policyFingerprint({})).toBe(await policyFingerprint({ refConstraint: "schema" }));
    expect(await policyFingerprint({ refConstraint: "schema" })).toBe("");
  });

  it('refConstraint "validate" changes the fingerprint (a real generation-schema change)', async () => {
    const schemaFp = await policyFingerprint({ refConstraint: "schema" });
    const validateFp = await policyFingerprint({ refConstraint: "validate" });
    expect(validateFp).not.toBe(schemaFp);
    expect(validateFp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns a 16-hex-character string once any fingerprinted field is set", async () => {
    const pf = await policyFingerprint({ outputLanguage: "Japanese" });
    expect(pf).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic: the same policy shape always fingerprints to the same value", async () => {
    const a = await policyFingerprint({ outputLanguage: "Japanese", designSystem: { guidelines: ["x"] } });
    const b = await policyFingerprint({ outputLanguage: "Japanese", designSystem: { guidelines: ["x"] } });
    expect(a).toBe(b);
  });

  it("differs when outputLanguage differs", async () => {
    const en = await policyFingerprint({ outputLanguage: "English" });
    const ja = await policyFingerprint({ outputLanguage: "Japanese" });
    expect(en).not.toBe(ja);
  });

  it("differs when designSystem's body differs (not just its presence)", async () => {
    const a = await policyFingerprint({ designSystem: { guidelines: ["a"] } });
    const b = await policyFingerprint({ designSystem: { guidelines: ["b"] } });
    expect(a).not.toBe(b);
  });

  it("fewShot without an id fingerprints as anonymous (same value as any other id-less fewShot)", async () => {
    const a = await policyFingerprint({ fewShot: { examples: async () => [] } });
    const b = await policyFingerprint({ fewShot: { examples: async () => [], maxExamples: 5 } });
    expect(a).toBe(b); // maxExamples does not participate — only the id (or its "anonymous" default)
  });

  it("fewShot.id changes the fingerprint (swapping the supply source separates the cache)", async () => {
    const anonymous = await policyFingerprint({ fewShot: { examples: async () => [] } });
    const named = await policyFingerprint({ fewShot: { examples: async () => [], id: "v2" } });
    expect(anonymous).not.toBe(named);
  });

  it("selectComponents.id changes the fingerprint; an id-less function fingerprints as anonymous", async () => {
    const bare: ComposePolicy["selectComponents"] = () => undefined;
    const withId: ComposePolicy["selectComponents"] = Object.assign(() => undefined, { id: "narrow-v1" });
    const bareFp = await policyFingerprint({ selectComponents: bare });
    const idFp = await policyFingerprint({ selectComponents: withId });
    expect(bareFp).not.toBe(idFp);
  });

  it("effort: unset is indistinguishable from a policy that never mentions the field", async () => {
    expect(await policyFingerprint({})).toBe(await policyFingerprint({ effort: undefined }));
  });

  it("effort participates once set, even with only one tier given", async () => {
    const pf = await policyFingerprint({ effort: { l1: "high" } });
    expect(pf).toMatch(/^[0-9a-f]{16}$/);
    expect(pf).not.toBe(await policyFingerprint({}));
  });

  it("effort.l1 and effort.l2 both participate independently", async () => {
    const l1Low = await policyFingerprint({ effort: { l1: "low" } });
    const l1High = await policyFingerprint({ effort: { l1: "high" } });
    expect(l1Low).not.toBe(l1High);
    const l2Set = await policyFingerprint({ effort: { l2: "low" } });
    expect(l1Low).not.toBe(l2Set);
  });

  it("cacheKey stays unchanged for a policy with no fingerprinted field set (backward compatible)", async () => {
    const ctx = makeCtx({ generatorVersion: "gv1" });
    const result = await compose(GUI_INPUT, ctx);
    expect(result.trace.cacheKey.endsWith(":gv1")).toBe(true);
  });

  it("cacheKey changes automatically once a policy sets a fingerprinted field, with no manual generatorVersion bump required", async () => {
    const bare = await compose(GUI_INPUT, makeCtx({ generatorVersion: "gv1" }));
    const withOutputLanguage = await compose(
      GUI_INPUT,
      makeCtx({ generatorVersion: "gv1", outputLanguage: "Japanese" }),
    );
    expect(bare.trace.cacheKey).not.toBe(withOutputLanguage.trace.cacheKey);
  });

  it("cacheKey changes automatically once ComposePolicy.effort is set", async () => {
    const bare = await compose(GUI_INPUT, makeCtx({ generatorVersion: "gv1" }));
    const withEffort = await compose(GUI_INPUT, makeCtx({ generatorVersion: "gv1", effort: { l1: "high" } }));
    expect(bare.trace.cacheKey).not.toBe(withEffort.trace.cacheKey);
  });

  it("designSystem.kit changes the fingerprint (Task 7b: the kit was previously invisible to the cache key)", async () => {
    const withoutKit = await policyFingerprint({
      designSystem: { tokens: { "--kohaku-color-primary": "brand color" } },
    });
    const withKit = await policyFingerprint({
      designSystem: { tokens: { "--kohaku-color-primary": "brand color" }, kit: DEFAULT_KIT_VOCABULARY },
    });
    expect(withKit).not.toBe(withoutKit);
  });

  it("two kits differing only in version produce different fingerprints", async () => {
    const kitV1: DesignKitVocabulary = DEFAULT_KIT_VOCABULARY;
    const kitV2: DesignKitVocabulary = { ...DEFAULT_KIT_VOCABULARY, version: "2" };
    const fpV1 = await policyFingerprint({ designSystem: { kit: kitV1 } });
    const fpV2 = await policyFingerprint({ designSystem: { kit: kitV2 } });
    expect(fpV1).not.toBe(fpV2);
  });

  it("enforceKitClasses: false differs from unset, while true is indistinguishable from unset", async () => {
    const unset = await policyFingerprint({ designSystem: { kit: DEFAULT_KIT_VOCABULARY } });
    const explicitTrue = await policyFingerprint({
      designSystem: { kit: DEFAULT_KIT_VOCABULARY, enforceKitClasses: true },
    });
    const explicitFalse = await policyFingerprint({
      designSystem: { kit: DEFAULT_KIT_VOCABULARY, enforceKitClasses: false },
    });
    expect(explicitTrue).toBe(unset);
    expect(explicitFalse).not.toBe(unset);
  });

  it("a kit-less policy's fingerprint is unchanged by the kit fold-in (regression guard)", async () => {
    const a = await policyFingerprint({
      designSystem: { tokens: { "--kohaku-color-primary": "brand color" }, guidelines: ["x"] },
    });
    const b = await policyFingerprint({
      designSystem: { tokens: { "--kohaku-color-primary": "brand color" }, guidelines: ["x"] },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("folding in the kit is additive — a kit-less design-system fingerprint is unchanged", async () => {
    // Pinned against the value produced BEFORE kit / enforceKitClasses joined the material.
    // If this changes, the new keys are being serialized (even as null) for policies that do not use
    // them, which silently invalidates every existing design-system consumer's compose cache.
    expect(
      await policyFingerprint({ designSystem: { tokens: { "color.primary": "brand" }, guidelines: ["a"] } }),
    ).toBe("a88d021f77ce79fd");
  });

  it("two composes with the same fingerprinted policy shape land on the same cache key (cache hit)", async () => {
    const storage = makeStorage();
    const ctx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage,
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
      policy: { outputLanguage: "Japanese" },
    };
    const first = await compose(GUI_INPUT, ctx);
    expect(first.trace.cache).toBe("miss");
    const second = await compose(GUI_INPUT, {
      ...ctx,
      llm: new FakeLlm({ objects: [goodRawDraft()] }),
    });
    expect(second.trace.cache).toBe("hit");
    expect(second.trace.cacheKey).toBe(first.trace.cacheKey);
  });
});

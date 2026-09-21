import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { FINGERPRINTED } from "../src/context.js";
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

  it('selectComponents.id = "" is nullish, not falsy: it fingerprints as "" itself, not as anonymous (M-4 cross-language parity)', async () => {
    // `?? "anonymous"` (nullish) is the correct read of ComposePolicy.selectComponents.id — an empty
    // string is a present id, distinct from "no id at all". The Python port's extractor used to use
    // `or "anonymous"` (falsy), which collapses "" into the same fingerprint as unset, diverging from
    // this implementation for that one input; see the sibling test in test_policy_fingerprint.py.
    const bare: ComposePolicy["selectComponents"] = () => undefined;
    const emptyId: ComposePolicy["selectComponents"] = Object.assign(() => undefined, { id: "" });
    const anonymousFp = await policyFingerprint({ selectComponents: bare });
    const emptyIdFp = await policyFingerprint({ selectComponents: emptyId });
    expect(emptyIdFp).not.toBe(anonymousFp);
    // Pinned against the Python-side value for the identical policy shape: with no other fingerprinted
    // field set, Python's usual designSystem cross-language divergence (enforceTokenColors' differing
    // default) does not apply, so this is one of the rare inputs where the two implementations' hashes
    // are expected to match byte-for-byte.
    expect(emptyIdFp).toBe("d6098cb7b6cf8828");
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

  it("two kits differing only in the insertion order of `classes` now produce the SAME fingerprint (Task 8/m-15)", async () => {
    // Before Task 8, designKitPromptFragment iterated Object.entries(kit.classes) in insertion order, so
    // this fingerprint material used to carry an explicit `classesOrder` array (sortDeep sorts object
    // keys before hashing, so `classes` alone would have hashed two such vocabularies identically even
    // though they emitted different L2 prompt bytes). Task 8/m-15 made designKitPromptFragment present
    // classes sorted by name instead, so the prompt is now a pure function of `classes`' *content*, not
    // its insertion order — `classesOrder` was removed accordingly (context.ts), and insertion-order-only
    // differences correctly stop separating the cache key too.
    const entries = Object.entries(DEFAULT_KIT_VOCABULARY.classes);
    const reordered: DesignKitVocabulary = {
      ...DEFAULT_KIT_VOCABULARY,
      classes: Object.fromEntries([...entries].reverse()),
    };
    const fpOriginal = await policyFingerprint({ designSystem: { kit: DEFAULT_KIT_VOCABULARY } });
    const fpReordered = await policyFingerprint({ designSystem: { kit: reordered } });
    expect(fpReordered).toBe(fpOriginal);
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

  it("folding in the kit is additive — a kit-less design-system fingerprint is unchanged", async () => {
    // Pinned against the value produced BEFORE kit / enforceKitClasses joined the material.
    // If this changes, the new keys are being serialized (even as null) for policies that do not use
    // them, which silently invalidates every existing design-system consumer's compose cache.
    // If this goes red, fix the material so the new key is absent by default — never update this
    // expected value. Re-pinning it is how the guarantee is lost.
    expect(
      await policyFingerprint({ designSystem: { tokens: { "color.primary": "brand" }, guidelines: ["a"] } }),
    ).toBe("a88d021f77ce79fd");
  });

  it("designSystem.kit alone is pinned to an exact fingerprint byte value (M-4 absolute pin)", async () => {
    // Absolute pin, unlike the relative-difference tests above (which only assert "differs from X" and
    // would stay green even if the kit material's byte layout was reshuffled). If this goes red for a
    // reason OTHER than the Task 8/m-15 `classesOrder` removal noted below, the kit material's bytes
    // changed — that silently invalidates the compose cache of every caller using a design kit. Fix the
    // code so it doesn't; never re-pin this value.
    //
    // Task 8/m-15: this value WAS re-pinned once, deliberately, when `classesOrder` was dropped from the
    // kit fingerprint material (context.ts's fingerprintDesignSystem) — designKitPromptFragment now sorts
    // classes by name instead of relying on `Object.entries` insertion order, so the material carrying
    // that order explicitly no longer corresponds to anything the prompt bytes depend on. Removing a key
    // from the material necessarily changes every fingerprint that includes `kit`, which is the expected,
    // one-time consequence of that change (recomputed via `policyFingerprint({ designSystem: { kit:
    // DEFAULT_KIT_VOCABULARY } })` against the post-m-15 code) — do not re-pin it again after this.
    expect(await policyFingerprint({ designSystem: { kit: DEFAULT_KIT_VOCABULARY } })).toBe(
      "910dd7582fefced5",
    );
  });

  it("designSystem.kit + enforceKitClasses: false is pinned to an exact fingerprint byte value (M-4 absolute pin)", async () => {
    // Same rationale as the kit-alone pin above, extended to cover enforceKitClasses's own byte
    // contribution once it participates. Also re-pinned once for the same Task 8/m-15 `classesOrder`
    // removal — see that test's comment.
    expect(
      await policyFingerprint({
        designSystem: { kit: DEFAULT_KIT_VOCABULARY, enforceKitClasses: false },
      }),
    ).toBe("3f6becbd7d40d6e0");
  });

  it("effort with only l1 set is pinned to an exact fingerprint byte value (M-4 absolute pin)", async () => {
    // If this goes red, effort's material bytes changed — every caller wiring adaptive-effort control
    // gets its compose cache silently invalidated. Fix the code, never re-pin this value.
    expect(await policyFingerprint({ effort: { l1: "high" } })).toBe("76b12e4c25cbdf74");
  });

  it("effort with both l1 and l2 set is pinned to an exact fingerprint byte value (M-4 absolute pin)", async () => {
    expect(await policyFingerprint({ effort: { l1: "high", l2: "low" } })).toBe("5bfd57f3558ec560");
  });

  it("tierLlm differing from the base model is pinned to an exact fingerprint byte value (M-4 absolute pin)", async () => {
    // tierLlm had no test coverage at all before M-4, absolute or relative — a policy-shape/byte-layout
    // regression here would have gone completely undetected. If this goes red, tierLlm's material bytes
    // changed — every caller wiring llmByTier away from the base model gets its compose cache silently
    // invalidated.
    expect(await policyFingerprint({}, { l1: { provider: "openai", modelId: "gpt-4" } })).toBe(
      "a1d7a984ef2d138e",
    );
  });

  it("fingerprints exactly the known set of ComposePolicy fields (detects an added/removed material key)", () => {
    // A new fingerprinted field must add a row to FINGERPRINTED (context.ts) *and* update this list in
    // the same change — this test exists so a forgotten update fails loudly instead of silently leaving
    // a field unfingerprinted (or an accidental key rename perturbing every existing cache key
    // unnoticed). See "the material key set" in context.ts's own doc comment for the M-4 discipline.
    expect(FINGERPRINTED.map(([key]) => key).sort()).toEqual(
      [
        "outputLanguage",
        "designSystem",
        "fewShotId",
        "selectComponentsId",
        "refConstraint",
        "effort",
        "tierLlm",
      ].sort(),
    );
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

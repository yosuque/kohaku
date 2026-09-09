import type { GenerateObjectRequest, GenerateObjectResult, LlmPort } from "@kohaku-ui/llm";
import type { GuiAction, SessionContext } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComposeContext, type ComposePolicy, compose, composeStream } from "../src/index.js";
import { catalog, goodRawDraft, makeSemantic, makeStorage, REF } from "./helpers.js";

const GUI_INPUT: GuiAction = {
  kind: "gui",
  action: "facet.change",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

const EN_SESSION: SessionContext = { surface: "web", locale: "en" };
const JA_SESSION: SessionContext = { surface: "web", locale: "ja" };

/** An LlmPort stub that captures every generation prompt (to assert the Output language section). */
function makeCapturingLlm(): { llm: LlmPort; prompts: string[] } {
  const prompts: string[] = [];
  const llm: LlmPort = {
    provider: "capture",
    modelId: "capture-model",
    async generateObject<T>(req: GenerateObjectRequest<T>): Promise<GenerateObjectResult<T>> {
      prompts.push(req.prompt);
      const ref = req.prompt.match(/query:\/\/\S+/)?.[0] ?? REF;
      return {
        object: goodRawDraft(ref) as T,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "capture-model",
      };
    },
    async generateText() {
      throw new Error("capture stub: generateText not supported");
    },
  };
  return { llm, prompts };
}

/** EN/JA policy pair following the product convention: JA varies the prompt AND the generatorVersion. */
const POLICY_BY_LANG: Record<"en" | "ja", ComposePolicy> = {
  en: { generatorVersion: "test-gen" },
  ja: { generatorVersion: "test-gen/ja", outputLanguage: "Japanese" },
};

function makeLangCtx(llm: LlmPort): ComposeContext {
  return {
    catalog,
    semantic: makeSemantic(),
    storage: makeStorage(),
    llm,
    policy: POLICY_BY_LANG.en,
    policyFor: (session) => POLICY_BY_LANG[session?.locale === "ja" ? "ja" : "en"],
  };
}

describe("compose: outputLanguage via policyFor", () => {
  it("a JA session policy inserts the Output language section with Japanese into the L1 prompt", async () => {
    const { llm, prompts } = makeCapturingLlm();
    await compose(GUI_INPUT, makeLangCtx(llm), { session: JA_SESSION });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Output language");
    expect(prompts[0]).toContain("Japanese");
  });

  it("an EN session (and no policyFor at all) keeps the default English instruction", async () => {
    const { llm, prompts } = makeCapturingLlm();
    await compose(GUI_INPUT, makeLangCtx(llm), { session: EN_SESSION });
    const plain = makeCapturingLlm();
    await compose(GUI_INPUT, {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm: plain.llm,
      policy: {},
    });
    for (const prompt of [prompts[0]!, plain.prompts[0]!]) {
      expect(prompt).toContain("## Output language");
      expect(prompt).toContain("English");
      expect(prompt).not.toContain("Japanese");
    }
  });

  it("EN and JA sessions get separate cache keys; a JA repeat hits the JA cache, not the EN one", async () => {
    const { llm } = makeCapturingLlm();
    const ctx = makeLangCtx(llm);
    const en = await compose(GUI_INPUT, ctx, { session: EN_SESSION });
    const ja = await compose(GUI_INPUT, ctx, { session: JA_SESSION });
    expect(en.trace.cacheKey).not.toBe(ja.trace.cacheKey);
    // The EN policy sets none of policyFingerprint's fields, so its key is unaffected (still exactly
    // 6 components). The JA policy sets outputLanguage, so policyFingerprint appends a 7th component
    // after the (already-bumped) generatorVersion — a belt-and-suspenders check on top of the JA
    // policy's existing manual generatorVersion bump, not a replacement for it.
    expect(en.trace.cacheKey.endsWith(":test-gen")).toBe(true);
    expect(ja.trace.cacheKey).toMatch(/:test-gen\/ja:[0-9a-f]{16}$/);
    // The EN entry was cached first; the JA request must have missed it and generated on its own.
    expect(en.trace.cache).toBe("miss");
    expect(ja.trace.cache).toBe("miss");
    const jaAgain = await compose(GUI_INPUT, ctx, { session: JA_SESSION });
    expect(jaAgain.trace.cache).toBe("hit");
    expect(jaAgain.trace.cacheKey).toBe(ja.trace.cacheKey);
  });

  it("a missing session resolves through policyFor to the default (EN) policy", async () => {
    const { llm } = makeCapturingLlm();
    const ctx = makeLangCtx(llm);
    const noSession = await compose(GUI_INPUT, ctx);
    const en = await compose(GUI_INPUT, ctx, { session: EN_SESSION });
    expect(noSession.trace.cacheKey).toBe(en.trace.cacheKey);
  });

  it("without policyFor the behavior is unchanged (same cache key as a plain policy context)", async () => {
    const { llm } = makeCapturingLlm();
    const plainCtx: ComposeContext = {
      catalog,
      semantic: makeSemantic(),
      storage: makeStorage(),
      llm,
      policy: POLICY_BY_LANG.en,
    };
    const { llm: llm2 } = makeCapturingLlm();
    const hookedCtx = makeLangCtx(llm2);
    const plain = await compose(GUI_INPUT, plainCtx, { session: JA_SESSION });
    const hooked = await compose(GUI_INPUT, hookedCtx, { session: EN_SESSION });
    // The plain context ignores the JA session entirely (no policyFor → EN policy stays).
    expect(plain.trace.cacheKey).toBe(hooked.trace.cacheKey);
  });

  it("composeStream resolves the session policy too (JA prompt + JA cache key on the stream path)", async () => {
    const { llm, prompts } = makeCapturingLlm();
    const ctx = makeLangCtx(llm);
    let cacheKey = "";
    for await (const ev of composeStream(GUI_INPUT, ctx, { session: JA_SESSION })) {
      if (ev.kind === "done") cacheKey = ev.result.trace.cacheKey;
    }
    // See the cache-key test above: JA's outputLanguage adds a policyFingerprint 7th component after
    // the generatorVersion this policy already bumps by hand.
    expect(cacheKey).toMatch(/:test-gen\/ja:[0-9a-f]{16}$/);
    expect(prompts.some((p) => p.includes("Japanese"))).toBe(true);
  });
});

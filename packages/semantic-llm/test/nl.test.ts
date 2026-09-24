import { defineIntent, defineVocabulary } from "@kohaku-ui/intents";
import { LlmError, type LlmErrorCode, type LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { SessionContext } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildNormalizeSystemPrompt,
  createIntentCatalog,
  createLlmSemanticPort,
  renderCatalogDoc,
  SemanticNormalizeError,
} from "../src/index.js";

const region = defineVocabulary("region", { japan: "Japan", europe: "Europe" });
const defs = [
  defineIntent({
    canonical: "sales.summary",
    description: "Aggregate sales by region",
    source: "sales",
    params: z.object({ region: region.enum().optional() }),
    examples: ["Sales by region"],
    queries: [{ path: "summary", paramMap: { region: "region" } }],
  }).toIntentDef(),
  defineIntent({
    canonical: "sales.custom",
    description: "Anything else",
    params: z.object({ request: z.string().min(1) }),
    examples: [],
    queries: () => [],
  }).toIntentDef(),
];
const catalog = createIntentCatalog(defs);
const CTX: SessionContext = { surface: "chat", locale: "ja" };

function throwingLlm(code: LlmErrorCode): LlmPort {
  return {
    provider: "stub",
    modelId: "stub",
    async generateObject() {
      throw new LlmError(code, `stub ${code}`);
    },
    async generateText() {
      throw new LlmError(code, `stub ${code}`);
    },
  };
}

function makePort(llm: LlmPort, fallbackIntent?: string) {
  return createLlmSemanticPort({
    llm,
    catalog,
    dataVersion: () => "v1",
    ...(fallbackIntent != null ? { fallbackIntent } : {}),
  });
}

describe("normalize (nl): happy path", () => {
  it("maps the model's structured answer onto the catalog and fills defaults", async () => {
    const llm = new FakeLlm({ objects: [{ intent: "sales.summary", params: { region: "japan" } }] });
    const out = await makePort(llm).normalize({ kind: "nl", text: "日本の売上" }, CTX);
    expect(out).toEqual({ canonical: "sales.summary", params: { region: "japan" } });
    const call = llm.calls[0]!;
    expect(call.schemaName).toBe("canonical_intent");
    expect(call.system).toBe(buildNormalizeSystemPrompt([]));
    expect(call.prompt).toBe(
      `## Intent catalog\n\n${renderCatalogDoc(catalog)}\n\n## User question (ja)\n日本の売上`,
    );
  });

  it("renders product rules between the generic lines", () => {
    const system = buildNormalizeSystemPrompt(["- Normalize region names to japan / europe"]);
    expect(system.split("\n")).toEqual([
      "You are the Intent normalizer for a business app. Map the user's question to exactly one Intent in the catalog below and",
      "extract its params. Rules:",
      "- Normalize region names to japan / europe",
      "- Include only the keys present in the schema in params",
    ]);
  });

  it("renderCatalogDoc lists every Intent with its JSON schema and examples, and is memoized per catalog object", () => {
    const doc = renderCatalogDoc(catalog);
    expect(doc).toContain("### sales.summary\nAggregate sales by region\nparams schema: ");
    expect(doc).toContain("Examples: Sales by region");
    expect(renderCatalogDoc(catalog)).toBe(doc);
  });
});

describe("normalize (nl): error classification", () => {
  it.each(["PROVIDER", "ABORTED", "CONFIG"] as const)("%s is thrown, not swallowed", async (code) => {
    await expect(
      makePort(throwingLlm(code)).normalize({ kind: "nl", text: "x" }, CTX),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("INVALID_OUTPUT falls back to fallbackIntent with params.request = the question", async () => {
    const out = await makePort(throwingLlm("INVALID_OUTPUT"), "sales.custom").normalize(
      { kind: "nl", text: "heatmap please" },
      CTX,
    );
    expect(out).toEqual({ canonical: "sales.custom", params: { request: "heatmap please" } });
  });

  it("an answer whose params fail validation also falls back", async () => {
    const llm = new FakeLlm({ objects: [{ intent: "sales.summary", params: { region: "mars" } }] });
    const out = await makePort(llm, "sales.custom").normalize({ kind: "nl", text: "mars sales" }, CTX);
    expect(out.canonical).toBe("sales.custom");
  });

  it("without fallbackIntent, an unmatched answer throws SemanticNormalizeError", async () => {
    const port = makePort(throwingLlm("INVALID_OUTPUT"));
    await expect(port.normalize({ kind: "nl", text: "heatmap please" }, CTX)).rejects.toBeInstanceOf(
      SemanticNormalizeError,
    );
  });
});

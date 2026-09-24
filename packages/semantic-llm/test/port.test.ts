import { defineIntent } from "@kohaku-ui/intents";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createIntentCatalog, createLlmSemanticPort } from "../src/index.js";

const catalog = createIntentCatalog([
  defineIntent({
    canonical: "sales.summary",
    description: "Summary",
    source: "sales",
    params: z.object({ groupBy: z.enum(["region", "product"]).default("region") }),
    examples: [],
    queries: [{ path: "summary", paramMap: { groupBy: "groupBy" } }],
  }).toIntentDef(),
]);

const port = createLlmSemanticPort({
  llm: new FakeLlm(),
  catalog: (tenant) => {
    if (tenant === "t2") return createIntentCatalog([]);
    return catalog;
  },
  dataVersion: () => "sales@v1",
  describeShape: (ref) =>
    ref.path === "summary"
      ? { columns: [{ name: String(ref.params["groupBy"] ?? "region"), type: "string", role: "dimension" }] }
      : null,
});

describe("createLlmSemanticPort", () => {
  it("resolveQuery expands the Intent's query templates (per tenant catalog)", async () => {
    expect(
      await port.resolveQuery({ canonical: "sales.summary", params: { groupBy: "product" }, hash: "h" }),
    ).toEqual([{ uri: "query://sales/summary?groupBy=product" }]);
    await expect(
      port.resolveQuery({ canonical: "sales.summary", params: {}, hash: "h" }, { tenant: "t2" }),
    ).rejects.toThrow(/unknown intent/);
  });

  it("dataVersion delegates to the option", async () => {
    expect(await port.dataVersion({ uri: "query://sales/summary" })).toBe("sales@v1");
  });

  it("describeShape parses the ref and delegates; an unknown path throws", async () => {
    expect(await port.describeShape!({ uri: "query://sales/summary?groupBy=product" })).toEqual({
      columns: [{ name: "product", type: "string", role: "dimension" }],
    });
    await expect(port.describeShape!({ uri: "query://sales/nope" })).rejects.toThrow(/unknown query path/);
  });

  it("gui input never touches the LLM", async () => {
    const llm = new FakeLlm();
    const p = createLlmSemanticPort({ llm, catalog, dataVersion: () => "v" });
    const out = await p.normalize(
      { kind: "gui", action: "view.select", params: { intent: "sales.summary" } },
      { surface: "web" },
    );
    expect(out).toEqual({ canonical: "sales.summary", params: { groupBy: "region" } });
    expect(llm.calls).toHaveLength(0);
  });

  it("threads the rules callback and the normalize() session context through to the system prompt", async () => {
    const llm = new FakeLlm({ objects: [{ intent: "sales.summary", params: { groupBy: "product" } }] });
    const p = createLlmSemanticPort({
      llm,
      catalog,
      dataVersion: () => "v",
      rules: (ctx) => [`- the requesting tenant is ${ctx.tenant ?? "none"}`],
    });
    await p.normalize({ kind: "nl", text: "top products" }, { surface: "chat", tenant: "acme" });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.system).toContain("- the requesting tenant is acme");
  });
});

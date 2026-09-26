import { defineIntent } from "@kohaku-ui/intents";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { IntentValidationError } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createIntentCatalog,
  createLlmSemanticPort,
  type IntentCatalogLike,
  UnknownIntentError,
} from "../src/index.js";

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

  it("resolveQuery on an unknown intent throws a typed UnknownIntentError (a string `code` property, `clientSafe: true`)", async () => {
    await expect(
      port.resolveQuery({ canonical: "sales.summary", params: {}, hash: "h" }, { tenant: "t2" }),
    ).rejects.toBeInstanceOf(UnknownIntentError);
    try {
      await port.resolveQuery({ canonical: "sales.summary", params: {}, hash: "h" }, { tenant: "t2" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownIntentError);
      expect((e as UnknownIntentError).code).toBe("UNKNOWN_INTENT");
      // clientSafe:true is what actually lets composer's SEMANTIC_FAILED wrapping (isClientSafeCause)
      // surface this message to the client — `code` alone is not enough (see refs.ts's doc).
      expect((e as UnknownIntentError).clientSafe).toBe(true);
      expect((e as UnknownIntentError).canonical).toBe("sales.summary");
      expect((e as Error).message).toBe('unknown intent "sales.summary"');
    }
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

  it("onNormalized fires after a matched NL normalization with fallback: false and the session's tenant", async () => {
    const llm = new FakeLlm({ objects: [{ intent: "sales.summary", params: { groupBy: "product" } }] });
    const seen: unknown[] = [];
    const p = createLlmSemanticPort({
      llm,
      catalog,
      dataVersion: () => "v",
      onNormalized: (info) => seen.push(info),
    });
    await p.normalize({ kind: "nl", text: "top products" }, { surface: "chat", tenant: "acme" });
    expect(seen).toEqual([
      { text: "top products", canonical: "sales.summary", fallback: false, tenant: "acme" },
    ]);
  });

  it("onNormalized fires with fallback: true on the fallback path, and omits tenant when the session has none", async () => {
    const llm = new FakeLlm({
      objects: [{ intent: "sales.summary", params: { groupBy: "not-a-valid-value" } }],
    });
    const seen: unknown[] = [];
    const p = createLlmSemanticPort({
      llm,
      catalog,
      dataVersion: () => "v",
      fallbackIntent: "sales.summary",
      onNormalized: (info) => seen.push(info),
    });
    await p.normalize({ kind: "nl", text: "top products" }, { surface: "chat" });
    expect(seen).toEqual([{ text: "top products", canonical: "sales.summary", fallback: true }]);
  });

  it("onNormalized is never called before a throw", async () => {
    const llm = new FakeLlm({
      objects: [{ intent: "sales.summary", params: { groupBy: "not-a-valid-value" } }],
    });
    let calls = 0;
    const p = createLlmSemanticPort({
      llm,
      catalog,
      dataVersion: () => "v",
      // no fallbackIntent: the mismatch throws SemanticNormalizeError, so the hook must never run.
      onNormalized: () => {
        calls++;
        throw new Error("boom");
      },
    });
    await expect(p.normalize({ kind: "nl", text: "top products" }, { surface: "chat" })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("a throwing onNormalized hook is caught and ignored (fail-open) and does not affect the returned result", async () => {
    const llm = new FakeLlm({
      objects: [{ intent: "sales.summary", params: { groupBy: "not-a-valid-value" } }],
    });
    let calls = 0;
    const p = createLlmSemanticPort({
      llm,
      catalog,
      dataVersion: () => "v",
      fallbackIntent: "sales.summary",
      onNormalized: () => {
        calls++;
        throw new Error("boom");
      },
    });
    await expect(p.normalize({ kind: "nl", text: "top products" }, { surface: "chat" })).resolves.toEqual({
      canonical: "sales.summary",
      params: { groupBy: "region" },
    });
    expect(calls).toBe(1);
  });

  describe("validateIntent", () => {
    it("accepts a fully-specified Intent and returns it unchanged (hash-stable)", async () => {
      const result = await port.validateIntent!(
        { canonical: "sales.summary", params: { groupBy: "product" } },
        { surface: "web" },
      );
      expect(result).toEqual({ canonical: "sales.summary", params: { groupBy: "product" } });
    });

    it("fills in a schema default the caller omitted (this changes the resulting intentHash, by design)", async () => {
      const result = await port.validateIntent!(
        { canonical: "sales.summary", params: {} },
        { surface: "web" },
      );
      expect(result).toEqual({ canonical: "sales.summary", params: { groupBy: "region" } });
    });

    it("rejects an unknown canonical", async () => {
      await expect(
        port.validateIntent!({ canonical: "sales.bogus", params: {} }, { surface: "web" }),
      ).rejects.toThrow(IntentValidationError);
      await expect(
        port.validateIntent!({ canonical: "sales.bogus", params: {} }, { surface: "web" }),
      ).rejects.toThrow(/unknown intent "sales\.bogus"/);
    });

    it("rejects an invalid param value", async () => {
      await expect(
        port.validateIntent!(
          { canonical: "sales.summary", params: { groupBy: "not-a-valid-value" } },
          { surface: "web" },
        ),
      ).rejects.toThrow(IntentValidationError);
    });

    it("rejects an unknown param key (the catalog's validateParams, not the looser normalizeParams)", async () => {
      const error = await port.validateIntent!(
        { canonical: "sales.summary", params: { groupBy: "region", bogus: 1 } },
        { surface: "web" },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntentValidationError);
      expect((error as IntentValidationError).issues).toEqual([
        { path: "bogus", message: 'unknown param "bogus"' },
      ]);
    });

    it("resolves the per-tenant catalog (an unknown intent in one tenant's empty catalog)", async () => {
      await expect(
        port.validateIntent!({ canonical: "sales.summary", params: {} }, { surface: "web", tenant: "t2" }),
      ).rejects.toThrow(/unknown intent/);
    });

    it("falls back to the looser (name-known?, normalizeParams) checks when the catalog has no validateParams", async () => {
      // A minimal IntentCatalogLike that implements only the required members (no validateParams) --
      // exercises createLlmSemanticPort's documented fallback path.
      const looseCatalog: IntentCatalogLike = {
        get: (name) => catalog.get(name),
        list: () => catalog.list(),
        names: () => catalog.names(),
        normalizeParams: (name, params) => catalog.normalizeParams(name, params),
      };
      const p = createLlmSemanticPort({ llm: new FakeLlm(), catalog: looseCatalog, dataVersion: () => "v" });
      // Fully valid params still succeed.
      await expect(
        p.validateIntent!({ canonical: "sales.summary", params: { groupBy: "product" } }, { surface: "web" }),
      ).resolves.toEqual({ canonical: "sales.summary", params: { groupBy: "product" } });
      // An unknown canonical is still rejected.
      await expect(
        p.validateIntent!({ canonical: "sales.bogus", params: {} }, { surface: "web" }),
      ).rejects.toThrow(IntentValidationError);
      // But an unknown param key is silently stripped rather than rejected (the fallback's known limitation --
      // normalizeParams' plain safeParse cannot distinguish it from a valid request).
      await expect(
        p.validateIntent!(
          { canonical: "sales.summary", params: { groupBy: "region", bogus: 1 } },
          { surface: "web" },
        ),
      ).resolves.toEqual({ canonical: "sales.summary", params: { groupBy: "region" } });
    });
  });
});

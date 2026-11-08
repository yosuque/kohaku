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

describe("createLlmSemanticPort describeFilters", () => {
  const filtered = createIntentCatalog([
    defineIntent({
      canonical: "sales.filtered",
      description: "Filtered",
      source: "sales",
      params: z.object({ groupBy: z.enum(["region", "product"]).default("region") }),
      examples: [],
      facets: [{ param: "groupBy", label: "Group by", labels: { ja: "集計軸" } }],
      queries: [{ path: "summary", paramMap: { groupBy: "by" } }],
    }).toIntentDef(),
    // No facets declared: the Intent exposes no filters.
    defineIntent({
      canonical: "sales.plain",
      description: "Plain",
      source: "sales",
      params: z.object({ groupBy: z.enum(["region", "product"]).default("region") }),
      examples: [],
      queries: [{ path: "summary", paramMap: { groupBy: "by" } }],
    }).toIntentDef(),
  ]);
  const p = createLlmSemanticPort({
    llm: new FakeLlm(),
    catalog: (tenant) => (tenant === "t2" ? createIntentCatalog([]) : filtered),
    dataVersion: () => "v",
  });
  const intent = (canonical: string) => ({ canonical, params: { groupBy: "region" }, hash: "h" });

  it("delegates to the Intent definition's filters()", async () => {
    expect(await p.describeFilters!(intent("sales.filtered"))).toEqual([
      {
        param: "groupBy",
        queryParam: "by",
        paths: ["summary"],
        label: "Group by",
        options: [
          { value: "region", label: "region" },
          { value: "product", label: "product" },
        ],
      },
    ]);
  });

  it("forwards the locale and selects the per-tenant catalog", async () => {
    const localized = await p.describeFilters!(intent("sales.filtered"), { locale: "ja" });
    expect(localized[0]?.label).toBe("集計軸");
    expect(await p.describeFilters!(intent("sales.filtered"), { tenant: "t2" })).toEqual([]);
  });

  it("returns [] for an Intent without facets or for an unknown Intent", async () => {
    expect(await p.describeFilters!(intent("sales.plain"))).toEqual([]);
    expect(await p.describeFilters!(intent("sales.bogus"))).toEqual([]);
  });
});

describe("createLlmSemanticPort describeFilters: the filters never widen what the Intent's params allow", () => {
  // A refine that forbids one combination: (private, detail). Each value alone is fine; the cartesian product
  // of the two facets includes the forbidden pair, which /compose would reject for that Intent.
  const docs = defineIntent({
    canonical: "x.docs",
    description: "Docs",
    source: "src",
    params: z
      .object({
        vis: z.enum(["public", "private"]).default("public"),
        level: z.enum(["summary", "detail"]).default("summary"),
      })
      .refine((p) => !(p.vis === "private" && p.level === "detail"), "private/detail is forbidden"),
    examples: [],
    facets: [
      { param: "vis", label: "Visibility" },
      { param: "level", label: "Level" },
    ],
    queries: [{ path: "docs", paramMap: { vis: "vis", level: "level" } }],
  }).toIntentDef();

  const portFor = (defs: Parameters<typeof createIntentCatalog>[0], maxFilterVariants?: number) =>
    createLlmSemanticPort({
      llm: new FakeLlm(),
      catalog: createIntentCatalog(defs),
      dataVersion: () => "v",
      ...(maxFilterVariants != null ? { maxFilterVariants } : {}),
    });
  const at = (canonical: string, params: Record<string, string | number>) => ({
    canonical,
    params,
    hash: "h",
  });

  it("returns no filters when a combination of the remaining filters violates the Intent's params (fail-safe)", async () => {
    const p = portFor([docs]);
    expect(await p.describeFilters!(at("x.docs", { vis: "public", level: "summary" }))).toEqual([]);
  });

  it("an option invalid against the CURRENT params is dropped before the product check (public/detail keeps only `level`)", async () => {
    const p = portFor([docs]);
    // With level=detail, vis=private is rejected on its own, so `vis` is left with one option and is dropped;
    // `level` alone has no forbidden combination.
    const filters = await p.describeFilters!(at("x.docs", { vis: "public", level: "detail" }));
    expect(filters.map((f) => f.param)).toEqual(["level"]);
  });

  it("drops an option the Intent's params reject on its own, and a filter left with fewer than 2 options", async () => {
    const narrowed = defineIntent({
      canonical: "x.narrow",
      description: "Narrow",
      source: "src",
      // `flavor` is a facet over curated options of which only two are valid enum members; `size` keeps one.
      params: z.object({
        flavor: z.enum(["a", "b"]).default("a"),
        size: z.enum(["s", "m", "l"]).default("s"),
      }),
      examples: [],
      facets: [
        {
          param: "flavor",
          label: "Flavor",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
            { value: "forbidden", label: "Forbidden" },
          ],
        },
        {
          param: "size",
          label: "Size",
          options: [
            { value: "s", label: "S" },
            { value: "nope", label: "Nope" },
          ],
        },
      ],
      queries: [{ path: "p", paramMap: { flavor: "flavor", size: "size" } }],
    }).toIntentDef();
    const filters = await portFor([narrowed]).describeFilters!(at("x.narrow", { flavor: "a", size: "s" }));
    // flavor loses "forbidden" (2 options remain); size is left with one option and is dropped.
    expect(filters.map((f) => [f.param, f.options.map((o) => o.value)])).toEqual([["flavor", ["a", "b"]]]);
  });

  it("keeps the filters when every combination is valid", async () => {
    const free = defineIntent({
      canonical: "x.free",
      description: "Free",
      source: "src",
      params: z.object({
        vis: z.enum(["public", "private"]).default("public"),
        level: z.enum(["summary", "detail"]).default("summary"),
      }),
      examples: [],
      facets: [
        { param: "vis", label: "Visibility" },
        { param: "level", label: "Level" },
      ],
      queries: [{ path: "docs", paramMap: { vis: "vis", level: "level" } }],
    }).toIntentDef();
    const filters = await portFor([free]).describeFilters!(at("x.free", { vis: "public", level: "summary" }));
    expect(filters.map((f) => f.param)).toEqual(["vis", "level"]);
  });

  it("bounds the product check by maxFilterVariants (default 64): over budget returns no filters", async () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`) as [string, ...string[]];
    const wide = defineIntent({
      canonical: "x.wide",
      description: "Wide",
      source: "src",
      params: z.object({ a: z.enum(values(9)).default("v0"), b: z.enum(values(9)).default("v0") }),
      examples: [],
      facets: [
        { param: "a", label: "A" },
        { param: "b", label: "B" },
      ],
      queries: [{ path: "p", paramMap: { a: "a", b: "b" } }],
    }).toIntentDef();
    // 9 x 9 = 81 > 64: not provable within the budget, so nothing is offered...
    expect(await portFor([wide]).describeFilters!(at("x.wide", { a: "v0", b: "v0" }))).toEqual([]);
    // ...and a product that raises the composer's l1FiltersMaxVariants raises this budget with it.
    const roomy = await portFor([wide], 81).describeFilters!(at("x.wide", { a: "v0", b: "v0" }));
    expect(roomy.map((f) => f.param)).toEqual(["a", "b"]);
  });

  it("does not vet a product over a filter the composer would not inject (an absent value stays un-vetted)", async () => {
    // region is optional and absent from the ref, so injectFilters skips its filter and the signed product holds
    // region at "absent". The refine forbids (private, detail) exactly there: the vis x level product must be
    // validated with region absent, not with region ranging over its options.
    const regional = defineIntent({
      canonical: "x.regional",
      description: "Regional",
      source: "src",
      params: z
        .object({
          vis: z.enum(["public", "private"]).default("public"),
          level: z.enum(["summary", "detail"]).default("summary"),
          region: z.enum(["a", "b"]).optional(),
        })
        .refine(
          (p) => !(p.vis === "private" && p.level === "detail" && p.region == null),
          "private/detail across all regions is forbidden",
        ),
      examples: [],
      facets: [
        { param: "vis", label: "V" },
        { param: "level", label: "L" },
        { param: "region", label: "R", emptyLabel: "All" },
      ],
      queries: [{ path: "docs", paramMap: { vis: "vis", level: "level", region: "region" } }],
    }).toIntentDef();
    const p = portFor([regional]);
    expect(await p.describeFilters!(at("x.regional", { vis: "public", level: "summary" }))).toEqual([]);
    // With region present in the ref it is injected and vetted, and the forbidden pair is no longer reachable
    // (region is never absent), so all three filters survive.
    const withRegion = await p.describeFilters!(
      at("x.regional", { vis: "public", level: "summary", region: "a" }),
    );
    expect(withRegion.map((f) => f.param)).toEqual(["vis", "level", "region"]);
  });

  it("validates through the catalog's own validator when it has one (what compose enforces), not just the schema", async () => {
    const free = defineIntent({
      canonical: "x.free",
      description: "Free",
      source: "src",
      params: z.object({
        vis: z.enum(["public", "private"]).default("public"),
        level: z.enum(["summary", "detail"]).default("summary"),
      }),
      examples: [],
      facets: [
        { param: "vis", label: "Visibility" },
        { param: "level", label: "Level" },
      ],
      queries: [{ path: "docs", paramMap: { vis: "vis", level: "level" } }],
    }).toIntentDef();
    const inner = createIntentCatalog([free]);
    // A product catalog layering a cross-field rule on top of the (constraint-free) schema.
    const strict: IntentCatalogLike = {
      get: (n) => inner.get(n),
      list: () => inner.list(),
      names: () => inner.names(),
      normalizeParams: (n, p) => inner.normalizeParams(n, p),
      validateParams: (n, p) => {
        const base = inner.validateParams(n, p);
        if (base.ok && base.params["vis"] === "private" && base.params["level"] === "detail") {
          return { ok: false, issues: [{ path: "", message: "private/detail is forbidden" }] };
        }
        return base;
      },
    };
    const mk = (catalog: IntentCatalogLike) =>
      createLlmSemanticPort({ llm: new FakeLlm(), catalog, dataVersion: () => "v" });
    const intent = at("x.free", { vis: "public", level: "summary" });
    expect(await mk(strict).describeFilters!(intent)).toEqual([]);
    expect((await mk(inner).describeFilters!(intent)).map((f) => f.param)).toEqual(["vis", "level"]);
    // Without validateParams the catalog's normalizeParams is the validator.
    const { validateParams: _drop, ...noValidate } = strict;
    const viaNormalize: IntentCatalogLike = {
      ...noValidate,
      normalizeParams: (n, p) => (strict.validateParams!(n, p).ok ? inner.normalizeParams(n, p) : null),
    };
    expect(await mk(viaNormalize).describeFilters!(intent)).toEqual([]);
  });

  it("an unknown Intent and an Intent without filters are unaffected", async () => {
    const p = portFor([docs]);
    expect(await p.describeFilters!(at("x.bogus", {}))).toEqual([]);
  });
});

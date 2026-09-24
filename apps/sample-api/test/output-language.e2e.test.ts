import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { FixationRecord, UISpec } from "@kohaku-ui/spec-core";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { languageOf } from "../src/app/compose-context.js";
import { createHeaderIdentity } from "../src/app/request-identity.js";
import { createApp } from "../src/app.js";

// End-to-end output language (EN/JA): session.locale on the wire selects the compose-context policy
// pair — JA gets JA L0 fixed specs and a "Japanese" Output-language section on the L1/L2 prompts,
// with cache separation riding the "/ja" generatorVersion token. EN stays byte-identical to the
// single-language era (golden.test.ts is the byte-stability guard).

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

function trendDraft(): unknown {
  return {
    components: [
      {
        id: "root",
        type: "layout.stack",
        props: { direction: "vertical", gap: null },
        children: ["h", "c"],
      },
      { id: "h", type: "text.heading", props: { level: 2, text: "月次売上の推移" } },
      {
        id: "c",
        type: "presentChart",
        props: { kind: "bar", x: "month", y: "revenue", series: null, stacked: null, title: null },
        children: null,
        data: { $ref: TREND_REF },
      },
    ],
    events: [],
  };
}

function makeMemoryStorage() {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(key: string) {
      return cache.get(key) ?? null;
    },
    async putSpecCache(key: string, spec: UISpec) {
      cache.set(key, spec);
    },
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

async function makeTestApp(objects: unknown[] = []) {
  const llm = new FakeLlm({ objects });
  const storage = makeMemoryStorage();
  const authz = createHmacAuthzPort("test-secret");
  return { ...(await createApp({ llm, storage, authz })), llm };
}

async function composeJson(app: Hono, body: unknown) {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as { spec: UISpec; capability: string } };
}

function headingText(spec: UISpec): string {
  const heading = spec.components.find((c) => c.type === "text.heading");
  return String((heading?.props as { text?: string } | undefined)?.text ?? "");
}

const KPI_GUI = {
  kind: "gui",
  action: "view.select",
  params: { intent: "sales.kpi_overview", fiscalYear: 2026, quarter: 2 },
};

describe("output language e2e: L0 fixed specs", () => {
  it("session.locale=ja serves the JA fixed spec; the default stays EN", async () => {
    const { app } = await makeTestApp();
    const ja = await composeJson(app, {
      input: KPI_GUI,
      session: { surface: "web", locale: "ja" },
    });
    expect(ja.res.status).toBe(200);
    expect(headingText(ja.json.spec)).toBe("2026年度Q2 業績サマリー");

    const en = await composeJson(app, { input: KPI_GUI });
    expect(headingText(en.json.spec)).toBe("FY2026 Q2 Performance Summary");
  });

  it("EN and JA responses cache separately (a JA repeat hits the JA cache, never the EN one)", async () => {
    const { app } = await makeTestApp();
    const en = await composeJson(app, { input: KPI_GUI, session: { surface: "web", locale: "en" } });
    expect(en.json.spec.provenance.cache).toBe("miss");
    const ja = await composeJson(app, { input: KPI_GUI, session: { surface: "web", locale: "ja" } });
    expect(ja.json.spec.provenance.cache).toBe("miss");
    const jaAgain = await composeJson(app, {
      input: KPI_GUI,
      session: { surface: "web", locale: "ja" },
    });
    expect(jaAgain.json.spec.provenance.cache).toBe("hit");
    expect(headingText(jaAgain.json.spec)).toBe("2026年度Q2 業績サマリー");
  });
});

describe("output language e2e: L1 generation prompt", () => {
  it("a JA session inserts the Output language section with Japanese into the L1 prompt", async () => {
    const { app, llm } = await makeTestApp([trendDraft()]);
    const { res } = await composeJson(app, {
      input: { kind: "gui", action: "view.select", params: { intent: "sales.trend" } },
      session: { surface: "web", locale: "ja" },
    });
    expect(res.status).toBe(200);
    const generation = llm.calls.find((c) => c.prompt.includes("## Output language"));
    expect(generation).toBeDefined();
    expect(generation!.prompt).toContain("Japanese");
  });
});

describe("output language e2e: NL normalization locale hint", () => {
  it("input.locale wins over the session and lands in the User question heading", async () => {
    const { app, llm } = await makeTestApp([{ intent: "sales.trend", params: {} }, trendDraft()]);
    const res = await app.request("/api/kohaku/intent/normalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { kind: "nl", text: "売上の月次推移", locale: "ja" },
        session: { surface: "chat", locale: "en" },
      }),
    });
    expect(res.status).toBe(200);
    expect(llm.calls[0]!.prompt).toContain("## User question (ja)");
  });

  it("falls back to session.locale when the input carries none", async () => {
    const { app, llm } = await makeTestApp([{ intent: "sales.trend", params: {} }]);
    await app.request("/api/kohaku/intent/normalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { kind: "nl", text: "monthly revenue trend" },
        session: { surface: "chat", locale: "en" },
      }),
    });
    expect(llm.calls[0]!.prompt).toContain("## User question (en)");
  });
});

describe("output language: fixation shortcut gate", () => {
  // fixationLookup (a plain read, locale-independent) and fixationAdmit (the EN-only delivery gate) are
  // separate KohakuHostDeps hooks (host-core's FixationDeliveryHost.admit); together they reproduce the
  // same net effect the old combined fixationLookup callback had: JA sessions never see a fixation shortcut.
  it("createHostDeps' fixationLookup is a plain read, independent of session.locale", async () => {
    const { createHostDeps } = await import("../src/app/host-deps.js");
    const record: FixationRecord = {
      intentHash: "sha256:x",
      canonical: "sales.kpi_overview",
      structureHash: "sha256:y",
      pinnedSpec: {} as UISpec,
      fixatedAt: "2026-01-01T00:00:00Z",
      approver: { id: "admin" },
    };
    const storage = { ...makeMemoryStorage(), getFixation: async () => record };
    const deps = createHostDeps({
      composeCtx: {} as never,
      domain: { listOperations: async () => [], invoke: async () => ({}) },
      authz: createHmacAuthzPort("test-secret"),
      storage,
      lineage: {} as never,
      promotions: {} as never,
      fixations: {} as never,
      identity: createHeaderIdentity(),
    });
    await expect(deps.fixationLookup!("sha256:x", { surface: "web", locale: "en" })).resolves.toBe(record);
    await expect(deps.fixationLookup!("sha256:x", { surface: "web" })).resolves.toBe(record);
    // The plain read no longer filters by locale — that is fixationAdmit's job (checked below).
    await expect(deps.fixationLookup!("sha256:x", { surface: "web", locale: "ja" })).resolves.toBe(record);
  });

  it("createHostDeps' fixationAdmit admits EN sessions only (JA falls through to compose)", async () => {
    const { createHostDeps } = await import("../src/app/host-deps.js");
    const record: FixationRecord = {
      intentHash: "sha256:x",
      canonical: "sales.kpi_overview",
      structureHash: "sha256:y",
      pinnedSpec: {} as UISpec,
      fixatedAt: "2026-01-01T00:00:00Z",
      approver: { id: "admin" },
    };
    const deps = createHostDeps({
      composeCtx: {} as never,
      domain: { listOperations: async () => [], invoke: async () => ({}) },
      authz: createHmacAuthzPort("test-secret"),
      storage: makeMemoryStorage(),
      lineage: {} as never,
      promotions: {} as never,
      fixations: {} as never,
      identity: createHeaderIdentity(),
    });
    expect(deps.fixationAdmit!(record, { surface: "web", locale: "en" })).toBe(true);
    expect(deps.fixationAdmit!(record, { surface: "web" })).toBe(true);
    expect(deps.fixationAdmit!(record, { surface: "web", locale: "ja" })).toBe(false);
  });
});

describe("languageOf", () => {
  it("maps ja / ja-JP to ja and everything else (including absence) to en", () => {
    expect(languageOf("ja")).toBe("ja");
    expect(languageOf("ja-JP")).toBe("ja");
    expect(languageOf("en")).toBe("en");
    expect(languageOf("en-US")).toBe("en");
    expect(languageOf("fr")).toBe("en");
    expect(languageOf(undefined)).toBe("en");
    // "jazz" must not prefix-match.
    expect(languageOf("jazz")).toBe("en");
  });
});

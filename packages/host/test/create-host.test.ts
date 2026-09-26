import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import type { FixedSpecSource } from "@kohaku-ui/composer";
import { defineIntent } from "@kohaku-ui/intents";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { type DomainPort, type SemanticPort, SPEC_VERSION, type UISpec } from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createKohakuHost } from "../src/create-host.js";

const SECRET_ENV = "KOHAKU_CAPABILITY_SECRET";

const testIntentDef = defineIntent({
  canonical: "test.view",
  description: "a trivial test view",
  params: z.object({}),
  examples: ["show the view"],
  source: "test",
  queries: [{ path: "summary" }],
}).toIntentDef();

const domain: DomainPort = {
  async listOperations() {
    return [{ name: "summary", description: "test op" }];
  },
  async invoke() {
    return { columns: [], rows: [], dataVersion: "v1" };
  },
};

/** An L0 fixed Spec for "test.view", so compose() never has to call the (unscripted) FakeLlm. */
function fixedSpecs(): FixedSpecSource {
  return {
    async lookup(intent) {
      if (intent.canonical !== "test.view") return null;
      return (canonicalIntent): UISpec => ({
        kohaku: SPEC_VERSION,
        intent: canonicalIntent,
        dataVersion: "template",
        components: [{ id: "root", type: "text.heading", props: { level: 2, text: "hello" } }],
        events: [],
        provenance: { tier: "L0", composedBy: "test-fixed-spec", cache: "miss" },
      });
    },
  };
}

async function composeTestView(app: Hono) {
  return app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "test.view", params: {} } }),
  });
}

describe("createKohakuHost", () => {
  const originalSecret = process.env[SECRET_ENV];
  afterEach(() => {
    if (originalSecret == null) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = originalSecret;
  });

  it("boots with every default and successfully composes an L0 view at the default base path", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      intents: [testIntentDef],
      dataVersion: () => "v1",
      policy: { fixedSpecs: fixedSpecs(), allowL2: false },
    });
    const res = await composeTestView(host.app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: UISpec; capability: string };
    expect(body.spec.provenance.tier).toBe("L0");
    expect(typeof body.capability).toBe("string");
  });

  it("mounts createKohakuRoutes at a custom basePath when given one", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      intents: [testIntentDef],
      dataVersion: () => "v1",
      policy: { fixedSpecs: fixedSpecs(), allowL2: false },
      basePath: "/custom",
    });
    const res = await host.app.request("/custom/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "test.view", params: {} } }),
    });
    expect(res.status).toBe(200);
  });

  it("each Port can be independently overridden, and overriding authz skips the secret requirement", () => {
    delete process.env[SECRET_ENV];
    const storage = createMemoryStoragePort();
    const authz = createHmacAuthzPort("does-not-matter-here");
    const semantic: SemanticPort = {
      async normalize() {
        throw new Error("normalize should not be called in this test");
      },
      async resolveQuery() {
        return [];
      },
      async dataVersion() {
        return "v1";
      },
    };
    const catalog = resolveCatalog(coreCatalog);
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      storage,
      authz,
      semantic,
      catalog,
    });
    expect(host.ports.storage).toBe(storage);
    expect(host.ports.authz).toBe(authz);
    expect(host.ports.semantic).toBe(semantic);
    expect(host.ports.domain).toBe(domain);
    expect(host.compose.catalog).toBe(catalog);
  });

  it("throws a clear error when no capability secret can be resolved and authz is not overridden", () => {
    delete process.env[SECRET_ENV];
    expect(() =>
      createKohakuHost({
        domain,
        querySource: "test",
        llm: new FakeLlm(),
        intents: [testIntentDef],
        dataVersion: () => "v1",
      }),
    ).toThrow(/capability secret/);
  });

  it("dev: true generates a temporary secret and warns on console.warn instead of throwing", () => {
    delete process.env[SECRET_ENV];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        createKohakuHost({
          domain,
          querySource: "test",
          llm: new FakeLlm(),
          intents: [testIntentDef],
          dataVersion: () => "v1",
          dev: true,
        }),
      ).not.toThrow();
      // createKohakuRoutes itself also warns at construction time about unwired deps.auth /
      // deps.authorizeGovernance (unrelated to the capability secret), so assert on presence rather than count.
      expect(warn.mock.calls.some((call) => /dev: true/.test(String(call[0])))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("throws a clear error when neither `semantic` nor `intents` is supplied", () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    expect(() =>
      createKohakuHost({
        domain,
        querySource: "test",
        llm: new FakeLlm(),
      }),
    ).toThrow(/semantic.*intents|intents.*semantic/i);
  });

  it("throws a clear error when `intents` is supplied without `dataVersion`", () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    expect(() =>
      createKohakuHost({
        domain,
        querySource: "test",
        llm: new FakeLlm(),
        intents: [testIntentDef],
      }),
    ).toThrow(/dataVersion/);
  });
});

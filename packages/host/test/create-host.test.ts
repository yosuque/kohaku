import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import type { FixedSpecSource } from "@kohaku-ui/composer";
import { defineIntent } from "@kohaku-ui/intents";
import { LlmError, type LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type DomainPort,
  type SemanticPort,
  type SessionContext,
  SPEC_VERSION,
  type UISpec,
} from "@kohaku-ui/spec-core";
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

  it("treats a whitespace-only KOHAKU_CAPABILITY_SECRET as missing", () => {
    // A user who pastes .env.example's commented block back in verbatim, or leaves a blank value, must
    // not get a silently-accepted "" or " " secret -- .trim() makes both fail the same way.
    process.env[SECRET_ENV] = "   ";
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
  it("records every compose into View Lineage by default, readable through host.lineage", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      intents: [testIntentDef],
      dataVersion: () => "v1",
      policy: { fixedSpecs: fixedSpecs(), allowL2: false },
    });
    expect(host.recorder).toBeDefined();
    const res = await composeTestView(host.app);
    expect(res.status).toBe(200);
    const events = await host.lineage.list({ type: ["view.composed"] });
    expect(events).toHaveLength(1);
    // The same events are what GET /lineage (and therefore `kohaku explain`) serves.
    const viaRest = await host.app.request("/api/kohaku/lineage?type=view.composed");
    expect(viaRest.status).toBe(200);
    expect(JSON.stringify(await viaRest.json())).toContain("view.composed");
  });

  it("recorder: false records nothing, and a custom recorder replaces the default", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const base = {
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      intents: [testIntentDef],
      dataVersion: () => "v1",
      policy: { fixedSpecs: fixedSpecs(), allowL2: false },
    };
    const silent = createKohakuHost({ ...base, recorder: false });
    expect(silent.recorder).toBeUndefined();
    await composeTestView(silent.app);
    expect(await silent.lineage.list({ type: ["view.composed"] })).toHaveLength(0);

    const composed = vi.fn(async () => {});
    const custom = createKohakuHost({
      ...base,
      recorder: { composed, interacted: async () => {} },
    });
    await composeTestView(custom.app);
    expect(composed).toHaveBeenCalledTimes(1);
    expect(await custom.lineage.list({ type: ["view.composed"] })).toHaveLength(0);
  });

  it("records action.* audit events for an action invoked through the facade, and actionAuditRecorder: false disables it", async () => {
    const actionDomain: DomainPort = {
      async listOperations() {
        return [{ name: "annotate", description: "annotate a record" }];
      },
      async invoke(op) {
        return { ok: true, op };
      },
    };
    const allowAuthz = {
      async issueCapability() {
        return "cap";
      },
      async verify() {
        return { ok: true as const, principal: { id: "u1", roles: ["user"] } };
      },
    };
    const build = (extra: { actionAuditRecorder?: false } = {}) =>
      createKohakuHost({
        domain: actionDomain,
        querySource: "test",
        llm: new FakeLlm(),
        authz: allowAuthz,
        intents: [testIntentDef],
        dataVersion: () => "v1",
        ...extra,
      });
    const post = (host: ReturnType<typeof build>, action: string) =>
      host.app.request("/api/kohaku/binding/action", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer cap" },
        body: JSON.stringify({ action, payload: {} }),
      });

    const host = build();
    expect(host.actionAuditRecorder).toBeDefined();
    expect((await post(host, "annotate")).status).toBe(200);
    expect(await host.lineage.list({ type: ["action.invoked"] })).toHaveLength(1);
    expect((await post(host, "not-declared")).status).toBe(403);
    expect(await host.lineage.list({ type: ["action.denied"] })).toHaveLength(1);

    const silent = build({ actionAuditRecorder: false });
    expect(silent.actionAuditRecorder).toBeUndefined();
    expect((await post(silent, "annotate")).status).toBe(200);
    expect(await silent.lineage.list({ type: ["action.invoked"] })).toHaveLength(0);
  });

  it("routes passes the remaining KohakuHostDeps fields through to createKohakuRoutes", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const authorizeGovernance = vi.fn(async () => false);
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      intents: [testIntentDef],
      dataVersion: () => "v1",
      policy: { fixedSpecs: fixedSpecs(), allowL2: false },
      routes: { authorizeGovernance },
    });
    const res = await host.app.request("/api/kohaku/lineage");
    expect(res.status).toBe(403);
    expect(authorizeGovernance).toHaveBeenCalled();
  });

  it("observer is combined with the console reporter, and policyFor reaches the compose context", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const onComposed = vi.fn();
    const policyFor = vi.fn(() => ({ fixedSpecs: fixedSpecs(), allowL2: false }));
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      intents: [testIntentDef],
      dataVersion: () => "v1",
      policyFor,
      observer: { onComposed },
    });
    expect(host.compose.policyFor).toBe(policyFor);
    // The console reporter's onError survives next to the caller's observer.
    expect(host.compose.observer?.onError).toBeTypeOf("function");
    const res = await composeTestView(host.app);
    expect(res.status).toBe(200);
    expect(policyFor).toHaveBeenCalled();
    expect(onComposed).toHaveBeenCalledTimes(1);
  });

  it("exposes approvals / rateLimiter / actionEffects as host.governance and logs a rate-limited line by default", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rateLimiter = { take: vi.fn(async () => ({ allow: false, retryAfterMs: 1000 })) };
      const host = createKohakuHost({
        domain,
        querySource: "test",
        llm: new FakeLlm(),
        intents: [testIntentDef],
        dataVersion: () => "v1",
        policy: { fixedSpecs: fixedSpecs(), allowL2: false },
        routes: { rateLimiter },
      });
      expect(host.governance.rateLimiter).toBe(rateLimiter);
      expect(host.governance.approvals).toBeUndefined();
      const res = await composeTestView(host.app);
      expect(res.status).toBe(429);
      // onRateLimited is fire-and-forget; let its microtask run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        log.mock.calls.some((c) => /\[kohaku\] rate limit \(compose\).*rate limited/.test(String(c[0]))),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("routes.onRateLimited replaces the default console line and is what host.governance carries", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const onRateLimited = vi.fn();
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: new FakeLlm(),
      intents: [testIntentDef],
      dataVersion: () => "v1",
      policy: { fixedSpecs: fixedSpecs(), allowL2: false },
      routes: { rateLimiter: { take: async () => ({ allow: false }) }, onRateLimited },
    });
    expect(host.governance.onRateLimited).toBe(onRateLimited);
    await composeTestView(host.app);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRateLimited).toHaveBeenCalledTimes(1);
  });

  it("passes fallbackIntent and rules through to the default SemanticPort", async () => {
    process.env[SECRET_ENV] = "test-secret-of-decent-length";
    const fallbackDef = defineIntent({
      canonical: "test.custom",
      description: "free-form request",
      params: z.object({ request: z.string() }),
      examples: [],
      source: "test",
      queries: () => [],
    }).toIntentDef();
    const invalidOutput: LlmPort = {
      provider: "stub",
      modelId: "stub",
      async generateObject() {
        throw new LlmError("INVALID_OUTPUT", "stub");
      },
      async generateText() {
        throw new LlmError("INVALID_OUTPUT", "stub");
      },
    };
    const rules = vi.fn((): string[] => []);
    const host = createKohakuHost({
      domain,
      querySource: "test",
      llm: invalidOutput,
      intents: [testIntentDef, fallbackDef],
      dataVersion: () => "v1",
      fallbackIntent: "test.custom",
      rules,
    });
    const session: SessionContext = { surface: "chat" };
    const out = await host.ports.semantic.normalize({ kind: "nl", text: "heatmap please" }, session);
    expect(out).toEqual({ canonical: "test.custom", params: { request: "heatmap please" } });
    expect(rules).toHaveBeenCalled();
  });
});

import type { ComposeContext } from "@kohaku-ui/composer";
import { LLM_PROVIDER_UNAVAILABLE_MESSAGE } from "@kohaku-ui/host-core";
import { LlmError, type LlmErrorCode } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  IntentInput,
  SemanticPort,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { IntentValidationError } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type FixationsApi, type KohakuHostDeps } from "../src/index.js";
import { INTENT_INVALID_MESSAGE } from "../src/routes/compose-pipeline.js";

// When the LLM provider cannot serve an Intent-resolution call (no API key, provider failure, abort), the
// REST host must answer 503 INTERNAL with a fixed message instead of 422 INTENT_INVALID with the provider
// SDK's raw wording. Covers every route that resolves an Intent: /intent/normalize, /events, /compose,
// /compose/stream and /fixations/approve. The original error must still reach onError.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";
const RAW_SDK_MESSAGE =
  "[claude/claude-sonnet-5] Anthropic API key is missing. Pass it using the 'apiKey' parameter or the ANTHROPIC_API_KEY environment variable.";

/** A SemanticPort whose normalize and validateIntent both always fail with `error`. */
function failingSemantic(error: Error): SemanticPort {
  return {
    async normalize() {
      throw error;
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@v1";
    },
    async validateIntent(): Promise<IntentInput> {
      throw error;
    },
  };
}

/** A SemanticPort that resolves any Intent fine, so a failure can only come from the LLM tier. */
function workingSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@v1";
    },
    async validateIntent(intent: IntentInput): Promise<IntentInput> {
      return intent;
    },
  };
}

function stubStorage(): StoragePort {
  const cache = new Map<string, UISpec>();
  return {
    async getSpecCache(k) {
      return cache.get(k) ?? null;
    },
    async putSpecCache(k, s) {
      cache.set(k, s);
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

const authz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "u", roles: ["user"] } };
  },
};

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return {};
  },
};

const fixations: FixationsApi = {
  async proposals() {
    return [];
  },
  async list() {
    return [];
  },
  async fixate() {
    return {};
  },
  async unfixate() {},
};

function makeDeps(
  semantic: SemanticPort,
  llm: ComposeContext["llm"] = new FakeLlm(),
): { deps: KohakuHostDeps; onError: ReturnType<typeof vi.fn> } {
  const onError = vi.fn();
  const deps: KohakuHostDeps = {
    compose: { catalog, semantic, storage: stubStorage(), llm, policy: {} },
    domain,
    authz,
    querySource: "sales",
    fixations,
    onError,
  };
  return { deps, onError };
}

interface Case {
  name: string;
  path: string;
  body: unknown;
}

const CASES: Case[] = [
  { name: "/intent/normalize", path: "/intent/normalize", body: { input: { kind: "nl", text: "revenue" } } },
  {
    name: "/events",
    path: "/events",
    body: {
      intent: { canonical: "sales.trend", params: {} },
      event: { on: "table1.sort", payload: {} },
    },
  },
  { name: "/compose (nl)", path: "/compose", body: { input: { kind: "nl", text: "revenue" } } },
  { name: "/compose/stream (nl)", path: "/compose/stream", body: { input: { kind: "nl", text: "revenue" } } },
  {
    name: "/fixations/approve",
    path: "/fixations/approve",
    body: { intent: { canonical: "sales.trend", params: {} } },
  },
];

function post(app: ReturnType<typeof createKohakuRoutes>, c: Case): Promise<Response> {
  return Promise.resolve(
    app.request(c.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c.body),
    }),
  );
}

type Envelope = { error: { code: string; message: string; requestId?: string } };

describe("an unavailable LLM provider during Intent resolution is 503 INTERNAL (fixed message)", () => {
  for (const code of ["PROVIDER", "CONFIG", "ABORTED"] as const satisfies LlmErrorCode[]) {
    for (const c of CASES) {
      it(`${c.name} answers 503 INTERNAL for LlmError ${code} and never echoes the SDK wording`, async () => {
        const error = new LlmError(code, RAW_SDK_MESSAGE);
        const { deps, onError } = makeDeps(failingSemantic(error));
        const app = createKohakuRoutes(deps);

        const res = await post(app, c);

        expect(res.status).toBe(503);
        const text = await res.text();
        expect(text).not.toContain("API key");
        expect(text).not.toContain("ANTHROPIC_API_KEY");
        const body = JSON.parse(text) as Envelope;
        expect(body.error.code).toBe("INTERNAL");
        expect(body.error.message).toBe(LLM_PROVIDER_UNAVAILABLE_MESSAGE);
        expect(typeof body.error.requestId).toBe("string");
        expect(body.error.requestId).not.toBe("");
        // The detail stays on the operator side: onError receives the original LlmError, with the same requestId.
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ error, requestId: body.error.requestId }),
        );
      });
    }
  }
});

describe("other Intent-resolution failures keep 422 INTENT_INVALID", () => {
  it("LlmError INVALID_OUTPUT collapses to the fixed INTENT_INVALID_MESSAGE (no raw wording)", async () => {
    const { deps } = makeDeps(failingSemantic(new LlmError("INVALID_OUTPUT", RAW_SDK_MESSAGE)));
    const app = createKohakuRoutes(deps);

    const res = await post(app, CASES[0] as Case);

    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain("API key");
    const body = JSON.parse(text) as Envelope;
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(body.error.message).toBe(INTENT_INVALID_MESSAGE);
  });

  it("an IntentValidationError is 422 with its own message", async () => {
    const { deps } = makeDeps(failingSemantic(new IntentValidationError('unknown intent "sales.bogus"')));
    const app = createKohakuRoutes(deps);

    const res = await post(app, CASES[4] as Case);

    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(body.error.message).toContain('unknown intent "sales.bogus"');
  });

  it("a typed no-match error (code NO_MATCH) is 422 with its own message", async () => {
    const noMatch = Object.assign(new Error("no intent matches the question"), { code: "NO_MATCH" });
    const { deps } = makeDeps(failingSemantic(noMatch));
    const app = createKohakuRoutes(deps);

    const res = await post(app, CASES[0] as Case);

    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(body.error.message).toBe("no intent matches the question");
  });
});

describe("POST /compose with a directly-specified Intent still degrades to a fallback Spec", () => {
  it("an LlmError PROVIDER from the L1 generation is 200 with provenance.fallback, not 503", async () => {
    const llm = new FakeLlm({
      objects: () => {
        throw new LlmError("PROVIDER", RAW_SDK_MESSAGE);
      },
    });
    const { deps } = makeDeps(workingSemantic(), llm);
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec: UISpec };
    expect(body.spec.provenance.fallback).toBeDefined();
  });
});

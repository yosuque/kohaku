import type { ComposeContext } from "@kohaku-ui/composer";
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

// A directly-specified Intent (kind: "intent") must be rejected with 422 INTENT_INVALID -- and leave no
// trace in the cache, lineage, or fixation store -- when the wired SemanticPort implements validateIntent
// and rejects it. Covers every REST entry point that funnels a directly-specified Intent through
// host-core's resolveIntent: POST /compose, POST /events (the pre-event `current`), and
// POST /fixations/approve.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

/** Only "sales.trend" with metric in {revenue, units} validates; everything else is rejected. */
function validatingSemantic(): SemanticPort {
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
      if (intent.canonical !== "sales.trend") {
        throw new IntentValidationError(`unknown intent "${intent.canonical}"`);
      }
      const metric = (intent.params["metric"] as string | undefined) ?? "revenue";
      if (metric !== "revenue" && metric !== "units") {
        throw new IntentValidationError('param "metric": expected one of revenue, units', [
          { path: "metric", message: 'param "metric": expected one of revenue, units' },
        ]);
      }
      return { canonical: intent.canonical, params: { ...intent.params, metric } };
    },
  };
}

function stubStorage(): { storage: StoragePort; putSpecCache: ReturnType<typeof vi.fn> } {
  const cache = new Map<string, UISpec>();
  const putSpecCache = vi.fn(async (k: string, s: UISpec) => {
    cache.set(k, s);
  });
  const storage: StoragePort = {
    async getSpecCache(k) {
      return cache.get(k) ?? null;
    },
    putSpecCache,
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
  return { storage, putSpecCache };
}

function allowAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true, principal: { id: "u", roles: ["user"] } };
    },
  };
}

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return {};
  },
};

function stubFixations(): { fixations: FixationsApi; fixate: ReturnType<typeof vi.fn> } {
  const fixate = vi.fn(async () => ({}));
  return {
    fixations: {
      async proposals() {
        return [];
      },
      async list() {
        return [];
      },
      fixate,
      async unfixate() {},
    },
    fixate,
  };
}

function makeDeps(): {
  deps: KohakuHostDeps;
  putSpecCache: ReturnType<typeof vi.fn>;
  fixate: ReturnType<typeof vi.fn>;
  composed: ReturnType<typeof vi.fn>;
  interacted: ReturnType<typeof vi.fn>;
} {
  const { storage, putSpecCache } = stubStorage();
  const { fixations, fixate } = stubFixations();
  const composed = vi.fn(async () => {});
  const interacted = vi.fn(async () => {});
  const compose: ComposeContext = {
    catalog,
    semantic: validatingSemantic(),
    storage,
    llm: new FakeLlm(),
    policy: {},
  };
  const deps: KohakuHostDeps = {
    compose,
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    fixations,
    recorder: { composed, interacted },
  };
  return { deps, putSpecCache, fixate, composed, interacted };
}

describe("POST /compose rejects an invalid directly-specified Intent", () => {
  it("an unknown canonical is 422 INTENT_INVALID and nothing is cached or recorded", async () => {
    const { deps, putSpecCache, composed } = makeDeps();
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.bogus", params: {} } }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(body.error.message).toContain('unknown intent "sales.bogus"');
    expect(putSpecCache).not.toHaveBeenCalled();
    expect(composed).not.toHaveBeenCalled();
  });

  it("an invalid param value is 422 INTENT_INVALID and nothing is cached or recorded", async () => {
    const { deps, putSpecCache, composed } = makeDeps();
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: { metric: "bogus" } } }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(body.error.message).toContain("metric");
    expect(putSpecCache).not.toHaveBeenCalled();
    expect(composed).not.toHaveBeenCalled();
  });

  it("a valid directly-specified Intent still composes normally (200)", async () => {
    const { deps } = makeDeps();
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: { metric: "units" } } }),
    });

    expect(res.status).toBe(200);
  });
});

describe("POST /events rejects an invalid `current` Intent", () => {
  it("an invalid current Intent is 422 INTENT_INVALID and interacted/composed are never recorded", async () => {
    const { deps, interacted, composed } = makeDeps();
    const app = createKohakuRoutes(deps);

    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: { canonical: "sales.trend", params: { metric: "bogus" } },
        event: { on: "table1.sort", payload: {} },
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(interacted).not.toHaveBeenCalled();
    expect(composed).not.toHaveBeenCalled();
  });
});

describe("POST /fixations/approve rejects an invalid Intent", () => {
  it("an invalid Intent is 422 INTENT_INVALID and the fixation is never written", async () => {
    const { deps, fixate, putSpecCache } = makeDeps();
    const app = createKohakuRoutes(deps);

    const res = await app.request("/fixations/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.bogus", params: {} } }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    // Rejected before composeForRest is ever called, so nothing is composed, cached, or fixated.
    expect(putSpecCache).not.toHaveBeenCalled();
    expect(fixate).not.toHaveBeenCalled();
  });
});

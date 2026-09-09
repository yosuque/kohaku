import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SemanticPort, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { cacheKey, finalizeIntent, GOVERNANCE_ERROR_DISCRIMINATORS } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type FixationsApi, type KohakuHostDeps } from "../src/index.js";

// /fixations/approve must refuse to pin a fallback Spec (a generation failure) or an L2 free-form result:
// both would otherwise be fixated as L0 for everyone.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

function stubSemantic(): SemanticPort {
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
  };
}

function stubStorage(): { storage: StoragePort; putFixation: ReturnType<typeof vi.fn> } {
  const cache = new Map<string, UISpec>();
  const putFixation = vi.fn(async () => {});
  const storage: StoragePort = {
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
    putFixation,
    async listFixations() {
      return [];
    },
  };
  return { storage, putFixation };
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

function stubFixations(): FixationsApi {
  return {
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
}

async function postApprove(hostDeps: KohakuHostDeps): Promise<{ status: number; body: unknown }> {
  const app = createKohakuRoutes(hostDeps);
  const res = await app.request("/fixations/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  });
  return { status: res.status, body: await res.json() };
}

describe("/fixations/approve refuses fallback and L2 results", () => {
  it("a generation failure (fallback Spec) is refused with 422 and the fixation is never written", async () => {
    const { storage, putFixation } = stubStorage();
    const compose: ComposeContext = {
      catalog,
      semantic: stubSemantic(),
      storage,
      // No scripted response: generateObject always throws "no scripted object response left", so L1
      // generation (and repair) fail, and with allowL2:false there is nothing left but the deterministic fallback.
      llm: new FakeLlm(),
      policy: { allowL2: false },
    };
    const deps: KohakuHostDeps = {
      compose,
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      fixations: stubFixations(),
    };

    const { status, body } = await postApprove(deps);

    expect(status).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe("COMPOSE_FAILED");
    expect((body as { error: { message: string } }).error.message).toContain(
      "a fallback Spec cannot be fixated",
    );
    expect(putFixation).not.toHaveBeenCalled();
  });

  it("an L2 free-form cached result is refused with 400 and the fixation is never written", async () => {
    const { storage, putFixation } = stubStorage();
    const compose: ComposeContext = {
      catalog,
      semantic: stubSemantic(),
      storage,
      llm: new FakeLlm(),
      policy: {},
    };
    const deps: KohakuHostDeps = {
      compose,
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      fixations: stubFixations(),
    };

    // Precompute the same cache key /fixations/approve's compose path will look up, and seed it with an
    // already-composed L2 result (as if a prior /compose call had promoted the Intent to free-form generation).
    const intent = await finalizeIntent({ canonical: "sales.trend", params: {} });
    const key = cacheKey({
      intentHash: intent.hash,
      dataVersion: "sales@v1",
      catalogFingerprint: catalog.fingerprint,
    });
    const l2Spec: UISpec = {
      kohaku: "0.1",
      intent: { canonical: "sales.trend", params: {}, hash: intent.hash },
      dataVersion: "sales@v1",
      components: [{ id: "root", type: "sandbox.html", props: { html: "<div>free-form</div>" } }],
      events: [],
      provenance: { tier: "L2", composedBy: "fixture", cache: "miss" },
    };
    await storage.putSpecCache(key, l2Spec);

    const { status, body } = await postApprove(deps);

    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    expect((body as { error: { message: string } }).error.message).toContain(
      "governed by the promotion pipeline",
    );
    expect(putFixation).not.toHaveBeenCalled();
  });
});

// §4.2 Q6: approve's catch (an unexpected failure past the fallback/L2 guards, e.g. the FixationsApi write
// itself) must mask a raw exception's message the same way /compose's COMPOSE_FAILED does, while the original
// error still reaches the observability hook.
describe("/fixations/approve masks an unexpected failure", () => {
  /** An L0 fixed template with no data reference, so composeForRest succeeds (no fallback, tier L0) and the
   * approve route reaches the fixations.fixate call below it. */
  function l0FixedSpec(): UISpec {
    return {
      kohaku: "0.1",
      intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
      dataVersion: "ignored",
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
        { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
      ],
      events: [],
      provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
    };
  }

  it("an unexpected fixations.fixate failure is 500 COMPOSE_FAILED without leaking the message, and reaches onError", async () => {
    const { storage } = stubStorage();
    const compose: ComposeContext = {
      catalog,
      semantic: stubSemantic(),
      storage,
      llm: new FakeLlm(),
      policy: { fixedSpecs: { lookup: async () => l0FixedSpec() } },
    };
    const seen: { endpoint: string; error: unknown }[] = [];
    const fixations: FixationsApi = {
      ...stubFixations(),
      async fixate() {
        throw new Error("secret internal detail");
      },
    };
    const deps: KohakuHostDeps = {
      compose,
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      fixations,
      onError: (info) => {
        seen.push({ endpoint: info.endpoint, error: info.error });
      },
    };

    const { status, body } = await postApprove(deps);

    expect(status).toBe(500);
    expect((body as { error: { code: string } }).error.code).toBe("COMPOSE_FAILED");
    expect((body as { error: { message: string } }).error.message).not.toContain("secret internal detail");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("fixations/approve");
    expect(seen[0]!.error).toBeInstanceOf(Error);
    expect((seen[0]!.error as Error).message).toBe("secret internal detail");
  });
});

describe("GET /fixations/proposals", () => {
  it("returns 200 with the proposals list shape", async () => {
    const proposal = {
      intentHash: "sha256:" + "0".repeat(64),
      canonical: "sales.trend",
      params: {},
      uses: 12,
      stability: 0.95,
    };
    const { storage } = stubStorage();
    const compose: ComposeContext = {
      catalog,
      semantic: stubSemantic(),
      storage,
      llm: new FakeLlm(),
      policy: {},
    };
    const fixations: FixationsApi = {
      ...stubFixations(),
      async proposals() {
        return [proposal];
      },
    };
    const deps: KohakuHostDeps = {
      compose,
      domain,
      authz: allowAuthz(),
      querySource: "sales",
      fixations,
    };

    const app = createKohakuRoutes(deps);
    const res = await app.request("/fixations/proposals");
    const body = (await res.json()) as { proposals: unknown[] };

    expect(res.status).toBe(200);
    expect(body.proposals).toEqual([proposal]);
  });

  it("is 501 NOT_IMPLEMENTED when fixations is not configured", async () => {
    const { storage } = stubStorage();
    const compose: ComposeContext = {
      catalog,
      semantic: stubSemantic(),
      storage,
      llm: new FakeLlm(),
      policy: {},
    };
    const deps: KohakuHostDeps = { compose, domain, authz: allowAuthz(), querySource: "sales" };

    const app = createKohakuRoutes(deps);
    const res = await app.request("/fixations/proposals");
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(501);
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });
});

describe("POST /fixations/:intentHash/remove", () => {
  function depsWithUnfixate(unfixate: FixationsApi["unfixate"]): KohakuHostDeps {
    const { storage } = stubStorage();
    const compose: ComposeContext = {
      catalog,
      semantic: stubSemantic(),
      storage,
      llm: new FakeLlm(),
      policy: {},
    };
    const fixations: FixationsApi = { ...stubFixations(), unfixate };
    return { compose, domain, authz: allowAuthz(), querySource: "sales", fixations };
  }

  it("maps a FixationUnsupportedError (deleteFixation unimplemented) to 501 NOT_IMPLEMENTED", async () => {
    const deps = depsWithUnfixate(async () => {
      throw Object.assign(new Error("deleteFixation is not implemented"), {
        code: GOVERNANCE_ERROR_DISCRIMINATORS.fixationUnsupportedCode,
      });
    });
    const app = createKohakuRoutes(deps);
    const res = await app.request(`/fixations/${"sha256:" + "0".repeat(64)}/remove`, { method: "POST" });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(501);
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("maps an arbitrary unfixate failure to 500 INTERNAL without leaking the original message", async () => {
    const deps = depsWithUnfixate(async () => {
      throw new Error("secret internal detail");
    });
    const app = createKohakuRoutes(deps);
    const res = await app.request(`/fixations/${"sha256:" + "0".repeat(64)}/remove`, { method: "POST" });
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("secret internal detail");
  });

  it("succeeds with {ok:true} when unfixate resolves", async () => {
    const deps = depsWithUnfixate(async () => {});
    const app = createKohakuRoutes(deps);
    const res = await app.request(`/fixations/${"sha256:" + "0".repeat(64)}/remove`, { method: "POST" });
    const body = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

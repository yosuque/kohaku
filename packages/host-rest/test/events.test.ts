import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SemanticPort, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// Mapping of Intent-normalization failures on POST /events:
// Symmetric with /compose, normalization (semantic.normalize / finalizeIntent) failures are client-caused and map
// to 422 INTENT_INVALID, while recomposition failures are internal errors and map to 500 COMPOSE_FAILED.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

/** A SemanticPort that throws when normalizing a gui action (reproduces unknown action -> INTENT_INVALID). */
function rejectingNormalizeSemantic(): SemanticPort {
  return {
    async normalize(input) {
      if (input.kind === "gui") throw new Error(`unknown action: ${input.action}`);
      return { canonical: "sales.trend", params: {}, hash: "" };
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@v1";
    },
  };
}

/** A SemanticPort that normalizes successfully but throws on reference resolution (reproduces internal error -> COMPOSE_FAILED). */
function failingComposeSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      throw new Error("reference resolution failed (test)");
    },
    async dataVersion() {
      return "sales@v1";
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

function composeCtx(semantic: SemanticPort): ComposeContext {
  return { catalog, semantic, storage: stubStorage(), llm: new FakeLlm(), policy: {} };
}

function makeDeps(semantic: SemanticPort): KohakuHostDeps {
  return { compose: composeCtx(semantic), domain, authz: allowAuthz(), querySource: "sales" };
}

/** on must be in "<componentId>.<event>" form (no dot is rejected with 400). */
function eventsReq(on: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent: { canonical: "sales.trend", params: {} },
      event: { on, payload: {} },
    }),
  };
}

describe("mapping of Intent normalization failure in POST /events", () => {
  it("normalization failure of an unknown action is 422 INTENT_INVALID (symmetric with /compose)", async () => {
    const app = createKohakuRoutes(makeDeps(rejectingNormalizeSemantic()));

    const res = await app.request("/events", eventsReq("table1.unknownAction"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
  });

  it("an internal error during recomposition (reference resolution) stays 500 COMPOSE_FAILED", async () => {
    const app = createKohakuRoutes(makeDeps(failingComposeSemantic()));

    const res = await app.request("/events", eventsReq("table1.sort"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("COMPOSE_FAILED");
  });

  it("even on a normalization-failure 422, onError is notified with endpoint=events and the requestId matches", async () => {
    const seen: { endpoint: string; requestId: string }[] = [];
    const deps: KohakuHostDeps = {
      ...makeDeps(rejectingNormalizeSemantic()),
      onError: (info) => {
        seen.push({ endpoint: info.endpoint, requestId: info.requestId });
      },
    };
    const app = createKohakuRoutes(deps);

    const res = await app.request("/events", eventsReq("table1.unknownAction"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; requestId?: string } };
    expect(body.error.code).toBe("INTENT_INVALID");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("events");
    expect(seen[0]!.requestId).toBe(body.error.requestId);
  });
});

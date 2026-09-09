import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SemanticPort, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// Body-shape hardening (§4.4 Minor): JsonObjectSchema's nesting-depth cap and SessionSchema's sessionId
// length cap, exercised end-to-end through /compose (the schema rejection happens in parseBody, before the
// compose pipeline runs, so the deps below are never actually invoked on the failing requests).

const catalog = resolveCatalog(coreCatalog);

function stubSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      return { uri: "query://sales/summary?fy=2026" };
    },
    async dataVersion() {
      return "sales@v1";
    },
  };
}

function stubStorage(): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
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

function makeDeps(): KohakuHostDeps {
  const compose: ComposeContext = {
    catalog,
    semantic: stubSemantic(),
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: {},
  };
  return { compose, domain, authz: allowAuthz(), querySource: "sales" };
}

/** Builds a JSON object literal nested `depth` levels deep (a bare `{leaf:true}` is depth 1). */
function nestedObject(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = { leaf: true };
  for (let i = 1; i < depth; i++) {
    obj = { nested: obj };
  }
  return obj;
}

async function postCompose(deps: KohakuHostDeps, body: unknown): Promise<{ status: number; body: unknown }> {
  const app = createKohakuRoutes(deps);
  const res = await app.request("/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("JsonObjectSchema nesting-depth cap (params)", () => {
  it("a params object nested 33 levels deep (over the 32 limit) is rejected with 400", async () => {
    const { status, body } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: nestedObject(33) },
    });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("a params object nested exactly 32 levels deep (at the limit) is accepted (passes schema validation)", async () => {
    const { status } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: nestedObject(32) },
    });
    // Schema validation passes; the request proceeds into the compose pipeline (200, not 400).
    expect(status).not.toBe(400);
  });
});

describe("SessionSchema sessionId length cap", () => {
  it("a sessionId over 128 characters is rejected with 400", async () => {
    const { status, body } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: {} },
      session: { surface: "web", sessionId: "a".repeat(129) },
    });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("a sessionId at exactly 128 characters is accepted (passes schema validation)", async () => {
    const { status } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: {} },
      session: { surface: "web", sessionId: "a".repeat(128) },
    });
    expect(status).not.toBe(400);
  });
});

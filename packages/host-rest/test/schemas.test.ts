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

async function postTelemetry(
  deps: KohakuHostDeps,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const app = createKohakuRoutes(deps);
  const res = await app.request("/telemetry", {
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

describe("SessionSchema surface / locale length caps (§4.5: bound client-supplied strings flowing into lineage records)", () => {
  it("a surface over 64 characters is rejected with 400", async () => {
    const { status, body } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: {} },
      session: { surface: "s".repeat(65) },
    });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("a surface at exactly 64 characters is accepted (passes schema validation)", async () => {
    const { status } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: {} },
      session: { surface: "s".repeat(64) },
    });
    expect(status).not.toBe(400);
  });

  it("a locale over 64 characters is rejected with 400", async () => {
    const { status, body } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: {} },
      session: { surface: "web", locale: "l".repeat(65) },
    });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("a locale at exactly 64 characters is accepted (passes schema validation)", async () => {
    const { status } = await postCompose(makeDeps(), {
      intent: { canonical: "sales.trend", params: {} },
      session: { surface: "web", locale: "l".repeat(64) },
    });
    expect(status).not.toBe(400);
  });
});

describe("TelemetryBodySchema string length caps (specHash/artifactId .max(128), surface/renderer .max(64))", () => {
  it("a rendered event's specHash over 128 characters is rejected with 400", async () => {
    const { status, body } = await postTelemetry(makeDeps(), {
      events: [{ kind: "rendered", specHash: "h".repeat(129) }],
    });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("a rendered event's specHash at exactly 128 characters is accepted", async () => {
    const { status } = await postTelemetry(makeDeps(), {
      events: [{ kind: "rendered", specHash: "h".repeat(128) }],
    });
    expect(status).toBe(200);
  });

  it("a rendered event's renderer over 64 characters is rejected with 400", async () => {
    const { status } = await postTelemetry(makeDeps(), {
      events: [{ kind: "rendered", specHash: "h", renderer: "r".repeat(65) }],
    });
    expect(status).toBe(400);
  });

  it("a componentUsed event's artifactId over 128 characters is rejected with 400", async () => {
    const { status, body } = await postTelemetry(makeDeps(), {
      events: [{ kind: "componentUsed", artifactId: "a".repeat(129) }],
    });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("a componentUsed event's artifactId at exactly 128 characters is accepted", async () => {
    const { status } = await postTelemetry(makeDeps(), {
      events: [{ kind: "componentUsed", artifactId: "a".repeat(128) }],
    });
    expect(status).toBe(200);
  });

  it("a componentUsed event's surface over 64 characters is rejected with 400", async () => {
    const { status } = await postTelemetry(makeDeps(), {
      events: [{ kind: "componentUsed", artifactId: "a", surface: "s".repeat(65) }],
    });
    expect(status).toBe(400);
  });
});

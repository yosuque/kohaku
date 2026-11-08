import type { ComposeContext } from "@kohaku-ui/composer";
import { STORAGE_CONFLICT_MESSAGE } from "@kohaku-ui/host-core";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  type DomainPort,
  type ErrorEnvelope,
  type SemanticPort,
  StorageConflictError,
  type StoragePort,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  createKohakuRoutes,
  type FixationsApi,
  type KohakuHostDeps,
  type PromotionsApi,
} from "../src/index.js";

// A StorageConflictError from a governance write (the StoragePort's optional compare-and-set lost a race with
// another host instance) is answered with the contract's 409 CONFLICT and the fixed message -- never the
// error's own text, never a 500, never retried inside the host.

const catalog = resolveCatalog(coreCatalog);

const semantic: SemanticPort = {
  async normalize() {
    return { canonical: "sales.trend", params: {}, hash: "" };
  },
  async resolveQuery() {
    return { uri: "query://sales/summary?fy=2026" };
  },
  async dataVersion() {
    return "sales@v1";
  },
};

const storage: StoragePort = {
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

const compose: ComposeContext = { catalog, semantic, storage, llm: new FakeLlm(), policy: {} };

const conflict = (): StorageConflictError => new StorageConflictError("promotion", "art-secret-key");

function conflictingPromotions(): PromotionsApi {
  const lose = async (): Promise<never> => {
    throw conflict();
  };
  return {
    async list() {
      return [];
    },
    async evaluateAndList() {
      return [];
    },
    async get(id) {
      return { artifactId: id, status: "candidate" };
    },
    act: lose,
    approve: lose,
    reject: lose,
    withdraw: lose,
  };
}

function conflictingFixations(): FixationsApi {
  return {
    async proposals() {
      return [];
    },
    async list() {
      return [];
    },
    async fixate() {
      throw conflict();
    },
    async unfixate() {
      throw new StorageConflictError("fixation", "intent-secret-hash");
    },
  };
}

function makeApp(overrides: Partial<KohakuHostDeps>) {
  const reported: { endpoint: string; error: unknown }[] = [];
  const app = createKohakuRoutes({
    compose,
    domain,
    authz,
    querySource: "sales",
    onError: (info) => {
      reported.push({ endpoint: info.endpoint, error: info.error });
    },
    ...overrides,
  });
  return { app, reported };
}

function post(app: ReturnType<typeof createKohakuRoutes>, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const draft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "d",
};

async function expectConflict(res: Response): Promise<void> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as ErrorEnvelope;
  expect(body.error.code).toBe("CONFLICT");
  expect(body.error.message).toBe(STORAGE_CONFLICT_MESSAGE);
  expect(body.error.requestId).toBeTypeOf("string");
  // The error's own text (record kind + key) never reaches the client.
  expect(JSON.stringify(body)).not.toContain("secret");
}

describe("409 CONFLICT for a storage compare-and-set conflict", () => {
  it("every promotion transition route answers 409 CONFLICT with the fixed message", async () => {
    const { app, reported } = makeApp({ promotions: conflictingPromotions() });

    await expectConflict(await post(app, "/promotions/known/approve", { draft }));
    await expectConflict(await post(app, "/promotions/known/reject", {}));
    await expectConflict(await post(app, "/promotions/known/withdraw", {}));
    await expectConflict(await post(app, "/promotions/known/actions", { action: { kind: "judge.start" } }));

    // An expected optimistic-concurrency outcome, not a host failure: it is not reported as an error.
    expect(reported).toEqual([]);
  });

  it("the fixation removal route answers 409 CONFLICT with the fixed message", async () => {
    const { app, reported } = makeApp({ fixations: conflictingFixations() });

    await expectConflict(await post(app, "/fixations/sha256:abc/remove"));

    expect(reported).toEqual([]);
  });

  it("is not retried inside the host: one failed call is one downstream call", async () => {
    let calls = 0;
    const promotions = conflictingPromotions();
    promotions.approve = async () => {
      calls++;
      throw conflict();
    };
    const { app } = makeApp({ promotions });

    await expectConflict(await post(app, "/promotions/known/approve", { draft }));

    expect(calls).toBe(1);
  });

  it("an unrelated failure is still a 500 INTERNAL with a fixed message (the conflict branch is not a catch-all)", async () => {
    const promotions = conflictingPromotions();
    promotions.approve = async () => {
      throw new Error("db password is hunter2");
    };
    const { app, reported } = makeApp({ promotions });

    const res = await post(app, "/promotions/known/approve", { draft });

    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(reported).toHaveLength(1);
  });
});

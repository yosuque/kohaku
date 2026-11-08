import type { ComposeContext } from "@kohaku-ui/composer";
import { STORAGE_CONFLICT_MESSAGE } from "@kohaku-ui/host-core";
import { createFixations, createLineage, createPromotions } from "@kohaku-ui/lineage";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  type DomainPort,
  type ErrorEnvelope,
  type FixationRecord,
  type LineageEventRecord,
  type PromotionState,
  type SemanticPort,
  StorageConflictError,
  type StoragePort,
  type UISpec,
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

    // Reported to onError under a dedicated endpoint (like the MCP profile), so conflicts can be measured;
    // the client message above stays fixed.
    expect(reported.map((r) => r.endpoint)).toEqual(Array(4).fill("storage.conflict"));
    expect(reported.every((r) => r.error instanceof StorageConflictError)).toBe(true);
  });

  it("the fixation removal route answers 409 CONFLICT with the fixed message", async () => {
    const { app, reported } = makeApp({ fixations: conflictingFixations() });

    await expectConflict(await post(app, "/fixations/sha256:abc/remove"));

    expect(reported.map((r) => r.endpoint)).toEqual(["storage.conflict"]);
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

// --- Real concurrency: two host instances (two route apps, two lineage/promotion services, two keyed
// mutexes) over ONE compare-and-set storage, the shape a shared redis / postgres has. The in-process mutex
// cannot order calls across the two apps, so only the storage's compare-and-set can make one of them lose.

/** A minimal in-memory StoragePort that honors expectedRevision (single-threaded, so each check-and-set is atomic). */
function sharedCasStorage(): StoragePort & { events: LineageEventRecord[] } {
  const events: LineageEventRecord[] = [];
  const promotions = new Map<string, PromotionState>();
  const fixations = new Map<string, FixationRecord>();
  return {
    events,
    supportsCompareAndSet: true,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
      events.push(event);
    },
    async listLineage(filter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      if (filter.artifactId != null)
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
      return result.slice(-(filter.limit ?? 200));
    },
    async getPromotionState(id) {
      const state = promotions.get(id);
      return state == null ? null : (JSON.parse(JSON.stringify(state)) as PromotionState);
    },
    async putPromotionState(state, options) {
      const expected = options?.expectedRevision;
      if (expected !== undefined) {
        const current = promotions.get(state.artifactId);
        if (expected === null ? current != null : current?.revision !== expected) {
          throw new StorageConflictError("promotion", state.artifactId);
        }
      }
      promotions.set(state.artifactId, state);
    },
    async listPromotionStates() {
      return [...promotions.values()];
    },
    async getFixation(intentHash) {
      const record = fixations.get(intentHash);
      return record == null ? null : (JSON.parse(JSON.stringify(record)) as FixationRecord);
    },
    async putFixation(record) {
      fixations.set(record.intentHash, record);
    },
    async listFixations() {
      return [...fixations.values()];
    },
    async deleteFixation(intentHash, _tenant, options) {
      const expected = options?.expectedRevision;
      if (expected !== undefined && fixations.get(intentHash)?.revision !== expected) {
        throw new StorageConflictError("fixation", intentHash);
      }
      fixations.delete(intentHash);
    },
  };
}

const HASH = "sha256:" + "0".repeat(64);
const pinnedSpec: UISpec = {
  kohaku: "0.1",
  intent: { canonical: "sales.trend", params: {}, hash: HASH },
  dataVersion: "pinned@v0",
  components: [{ id: "root", type: "presentMarkdown", props: { markdown: "pinned" } }],
  events: [],
  provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
};

function twoInstances(storage: ReturnType<typeof sharedCasStorage>) {
  const make = () =>
    createKohakuRoutes({
      compose: { ...compose, storage },
      domain,
      authz,
      querySource: "sales",
      promotions: createPromotions({
        lineage: createLineage({ storage }),
        storage,
      }) as unknown as PromotionsApi,
      fixations: createFixations({ lineage: createLineage({ storage }), storage }) as unknown as FixationsApi,
    });
  return [make(), make()] as const;
}

describe("two host instances over one compare-and-set storage", () => {
  it("two concurrent promotion transitions on the same artifact: exactly one succeeds, the other is a 409 CONFLICT", async () => {
    const storage = sharedCasStorage();
    storage.events.push({
      id: "g-1",
      ts: new Date().toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: { artifactId: "art-1", html: "<html></html>", request: "r" },
    });
    const [a, b] = twoInstances(storage);
    const body = { action: { kind: "nominate" } };

    const [ra, rb] = await Promise.all([
      post(a, "/promotions/art-1/actions", body),
      post(b, "/promotions/art-1/actions", body),
    ]);

    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    await expectConflict(loser);
    expect((await storage.getPromotionState("art-1"))?.status).toBe("candidate");
  });

  it("two concurrent fixation removals: exactly one succeeds, the other is a 409 CONFLICT, and only one intent.unfixated is recorded", async () => {
    const storage = sharedCasStorage();
    await storage.putFixation({
      intentHash: HASH,
      canonical: "sales.trend",
      structureHash: "sha256:" + "1".repeat(64),
      pinnedSpec,
      fixatedAt: "2026-07-01T00:00:00Z",
      approver: { id: "tester" },
      revision: "r1",
    });
    const [a, b] = twoInstances(storage);

    const [ra, rb] = await Promise.all([
      post(a, `/fixations/${HASH}/remove`),
      post(b, `/fixations/${HASH}/remove`),
    ]);

    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    await expectConflict(ra.status === 409 ? ra : rb);
    expect(await storage.getFixation(HASH)).toBeNull();
    expect(storage.events.filter((e) => e.type === "intent.unfixated")).toHaveLength(1);
  });
});

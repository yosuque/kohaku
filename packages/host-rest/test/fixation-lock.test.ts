import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  computeStructureHash,
  type DomainPort,
  type FixationRecord,
  finalizeIntent,
  type SemanticPort,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type FixationsApi, type KohakuHostDeps } from "../src/index.js";

// Characterization of the fixation lock host-rest wires today: self-healing's fire-and-forget
// refreshFingerprint (fired by /compose when a fixation's catalog fingerprint is stale but its pinned Spec still
// validates) and the management plane's fixate (POST /fixations/approve) are serialized per
// (tenant, intentHash) on the same createKohakuRoutes app, and are NOT serialized across keys. These pin what the
// code does, so the per-deps WeakMaps -> RouteContext move (and the later host-core extraction) must keep them green.
// Fixtures follow fixation-staleness.test.ts (the "revalidated" path) and fixation-approve.test.ts.

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

function domainWith(listOperations: DomainPort["listOperations"]): DomainPort {
  return {
    listOperations,
    async invoke() {
      return { ok: true };
    },
  };
}

const noOperations = domainWith(async () => []);

/** The fallback target for normal compose (deterministic L0 markdown; no LLM needed). */
function fallbackFixed(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "normal compose fallback" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function composeCtx(): ComposeContext {
  return {
    catalog,
    semantic: stubSemantic(),
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: { fixedSpecs: { lookup: async () => fallbackFixed() } },
  };
}

function validPinned(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "pinned@v0",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["md1"] },
      { id: "md1", type: "presentMarkdown", props: { markdown: "Pinned view" } },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

// The real resolved hash of the request body's intent ({canonical:"sales.trend", params:{}}).
const REQUEST_INTENT = await finalizeIntent({ canonical: "sales.trend", params: {} });

/** A fixation whose catalog fingerprint differs from the current catalog: /compose delivers it and fires refreshFingerprint. */
async function staleFingerprintFixation(): Promise<FixationRecord> {
  const pinnedSpec = validPinned();
  return {
    intentHash: REQUEST_INTENT.hash,
    canonical: "sales.trend",
    structureHash: await computeStructureHash(pinnedSpec),
    pinnedSpec,
    fixatedAt: "2026-06-10T00:00:00Z",
    approver: { id: "tester" },
    catalogFingerprint: "sha256:stale-fp",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One app whose first refreshFingerprint call stays pending until `release()`; every later call resolves
 * immediately. `order` records the interleaving (refresh-enter / refresh-exit / fixate-enter).
 */
async function pendingRefreshApp(): Promise<{
  app: ReturnType<typeof createKohakuRoutes>;
  order: string[];
  release: () => void;
}> {
  const fixation = await staleFingerprintFixation();
  const order: string[] = [];
  const gate = deferred();
  let refreshCalls = 0;
  const fixations: FixationsApi = {
    async proposals() {
      return [];
    },
    async list() {
      return [];
    },
    async fixate() {
      order.push("fixate-enter");
      return {};
    },
    async unfixate() {},
    async refreshFingerprint() {
      refreshCalls += 1;
      order.push("refresh-enter");
      if (refreshCalls === 1) await gate.promise;
      order.push("refresh-exit");
    },
  };
  const deps: KohakuHostDeps = {
    compose: composeCtx(),
    domain: noOperations,
    authz,
    querySource: "sales",
    tenant: (c) => c.req.header("x-tenant"),
    // Only the request intent has a fixation (so a different intentHash falls through to normal compose);
    // the lookup ignores the tenant, so any tenant meets the same stale-fingerprint fixation.
    fixationLookup: async (intentHash) => (intentHash === REQUEST_INTENT.hash ? fixation : null),
    fixations,
  };
  return { app: createKohakuRoutes(deps), order, release: gate.resolve };
}

function postCompose(
  app: ReturnType<typeof createKohakuRoutes>,
  tenant: string,
): Promise<Response> | Response {
  return app.request("/compose", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  });
}

function postApprove(
  app: ReturnType<typeof createKohakuRoutes>,
  tenant: string,
  params: Record<string, string>,
): Promise<Response> | Response {
  return app.request("/fixations/approve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params } }),
  });
}

describe("the fixation lock is shared between self-heal and the management plane (host-rest)", () => {
  it("a pending refreshFingerprint for (t1, X) blocks the fixate of /fixations/approve for the same (t1, X)", async () => {
    const { app, order, release } = await pendingRefreshApp();

    expect((await postCompose(app, "t1")).status).toBe(200);
    await vi.waitFor(() => expect(order).toEqual(["refresh-enter"]));

    order.push("approve-requested");
    const approve = postApprove(app, "t1", {});
    // approve's own composeForRest meets the same stale-fingerprint fixation and queues a second
    // refreshFingerprint on the same key ahead of fixate; nothing may run while the first one is pending.
    await tick();
    expect(order).toEqual(["refresh-enter", "approve-requested"]);

    release();
    expect((await approve).status).toBe(200);
    expect(order).toEqual([
      "refresh-enter",
      "approve-requested",
      "refresh-exit",
      "refresh-enter",
      "refresh-exit",
      "fixate-enter",
    ]);
  });

  it("a different intentHash is not serialized: fixate enters while refreshFingerprint is still pending", async () => {
    const { app, order, release } = await pendingRefreshApp();

    expect((await postCompose(app, "t1")).status).toBe(200);
    await vi.waitFor(() => expect(order).toEqual(["refresh-enter"]));

    // A different intent (params differ -> a different hash): no fixation, normal compose, fixate under (t1, Y).
    const approve = await postApprove(app, "t1", { region: "emea" });
    expect(approve.status).toBe(200);
    expect(order).toEqual(["refresh-enter", "fixate-enter"]);

    release();
    await vi.waitFor(() => expect(order).toEqual(["refresh-enter", "fixate-enter", "refresh-exit"]));
  });

  it("a different tenant is not serialized: its refreshFingerprint and fixate run while (t1, X) is still pending", async () => {
    const { app, order, release } = await pendingRefreshApp();

    expect((await postCompose(app, "t1")).status).toBe(200);
    await vi.waitFor(() => expect(order).toEqual(["refresh-enter"]));

    // Same intentHash X, but tenant t2: approve's composeForRest fires its own refreshFingerprint under (t2, X)
    // (resolves immediately), then fixate runs under (t2, X) -- all before (t1, X) is released.
    const approve = await postApprove(app, "t2", {});
    expect(approve.status).toBe(200);
    expect(order).toEqual(["refresh-enter", "refresh-enter", "refresh-exit", "fixate-enter"]);

    release();
    await vi.waitFor(() =>
      expect(order).toEqual([
        "refresh-enter",
        "refresh-enter",
        "refresh-exit",
        "fixate-enter",
        "refresh-exit",
      ]),
    );
  });
});

describe("the operation index is memoized per app (host-rest)", () => {
  it("listOperations is called exactly once across several /binding/action requests", async () => {
    const listOperations = vi.fn(async () => [{ name: "annotate", description: "d" }]);
    const app = createKohakuRoutes({
      compose: composeCtx(),
      domain: domainWith(listOperations),
      authz,
      querySource: "sales",
    });
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/binding/action", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer cap" },
        body: JSON.stringify({ action: "annotate", payload: {} }),
      });
      expect(res.status).toBe(200);
    }
    expect(listOperations).toHaveBeenCalledTimes(1);
  });
});

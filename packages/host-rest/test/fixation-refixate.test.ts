import type { ComposeContext } from "@kohaku-ui/composer";
import { createFixations, createLineage } from "@kohaku-ui/lineage";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  type DomainPort,
  type FilterDescriptor,
  type FixationRecord,
  finalizeIntent,
  type SemanticPort,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type FixationsApi, type KohakuHostDeps } from "../src/index.js";

// Re-approving an already-fixated Intent composes to the fixation DELIVERY (tier L0, cache "fixated"). Pinning
// that would launder an L1 pin (whose injected data.bind the composer re-checks) into an L0 pin that is never
// checked again; fixate is idempotent for a delivery instead.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";
const GROUP_BY: FilterDescriptor = {
  param: "groupBy",
  queryParam: "groupBy",
  paths: ["summary"],
  label: "Group by",
  options: [
    { value: "region", label: "R" },
    { value: "product", label: "P" },
    { value: "channel", label: "C" },
  ],
};
const NARROWED: FilterDescriptor = { ...GROUP_BY, options: GROUP_BY.options.slice(0, 2) };

function semantic(filters: FilterDescriptor[]): SemanticPort {
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
    async describeFilters() {
      return filters;
    },
  };
}

function memoryStorage(fixed: Map<string, FixationRecord>): StoragePort {
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
    async getFixation(h) {
      return fixed.get(h) ?? null;
    },
    async putFixation(rec) {
      fixed.set(rec.intentHash, rec);
    },
    async deleteFixation(h) {
      fixed.delete(h);
    },
    async listFixations() {
      return [...fixed.values()];
    },
  } as StoragePort;
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

const REQUEST_INTENT = await finalizeIntent({ canonical: "sales.trend", params: {} });

/** An L1 pin carrying composer-injected-style binds, as `fixate` would have been handed after an L1 compose. */
function injectedL1(): UISpec {
  return {
    kohaku: "0.1",
    intent: REQUEST_INTENT,
    dataVersion: "pinned@v0",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["t"] },
      {
        id: "t",
        type: "presentSpreadsheet",
        props: {},
        data: {
          $ref: REF,
          bind: { groupBy: { $state: "groupBy", values: ["region", "product", "channel"] } },
        },
      },
    ],
    events: [],
    state: { groupBy: "region" },
    provenance: { tier: "L1", composedBy: "fixture", cache: "miss" },
  };
}

function setup(filters: { current: FilterDescriptor[] }) {
  const fixed = new Map<string, FixationRecord>();
  const storage = memoryStorage(fixed);
  const fixations = createFixations({
    lineage: createLineage({ storage }),
    storage,
    catalogFor: () => catalog,
  });
  const compose: ComposeContext = {
    catalog,
    // describeFilters reads the mutable holder, so the test can narrow the descriptors between requests.
    semantic: {
      ...semantic([]),
      describeFilters: async () => filters.current,
    },
    storage,
    llm: new FakeLlm(),
  };
  const deps: KohakuHostDeps = {
    compose,
    domain,
    authz,
    querySource: "sales",
    fixationLookup: async (h) => fixed.get(h) ?? null,
    fixations: fixations as unknown as FixationsApi,
  };
  return { fixed, fixations, app: createKohakuRoutes(deps) };
}

const post = (app: ReturnType<typeof createKohakuRoutes>, path: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  });

describe("re-approving an already-fixated Intent does not launder an L1 pin into L0", () => {
  it("fixate, re-fixate (idempotent), narrow the descriptor -> the pin is stale and removed", async () => {
    const filters = { current: [GROUP_BY] };
    const { fixed, fixations, app } = setup(filters);

    const first = await fixations.fixate({ pinnedSpec: injectedL1(), approver: { id: "admin" } });
    expect(first.pinnedSpec.provenance.tier).toBe("L1");

    // Re-approve through the route: composes to the fixation delivery and must NOT pin it.
    const res = await post(app, "/fixations/approve");
    expect(res.status).toBe(200);
    const again = ((await res.json()) as { fixation: FixationRecord }).fixation;
    expect(again.revision).toBe(first.revision);
    expect(fixed.get(first.intentHash)!.pinnedSpec.provenance.tier).toBe("L1");

    // The Intent narrows its options: the (still L1) pin is checked and goes stale.
    filters.current = [NARROWED];
    const composed = await post(app, "/compose");
    const spec = ((await composed.json()) as { spec: UISpec }).spec;
    expect(spec.provenance.cache).not.toBe("fixated");
    await new Promise((r) => setTimeout(r, 0));
    expect(fixed.has(first.intentHash)).toBe(false);
  });
});

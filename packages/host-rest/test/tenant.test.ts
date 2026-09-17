import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  computeStructureHash,
  type DomainPort,
  type FixationRecord,
  finalizeIntent,
  type LineageEventRecord,
  type SemanticPort,
  type SessionContext,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps, type ViewRecorder } from "../src/index.js";

// host-rest wiring tests for the multi-tenant contract:
// - x-kohaku-tenant header -> SessionContext.tenant -> propagates to recorder.composed.
// - fixationLookup receives SessionContext (with tenant) and can deliver per-tenant fixations.

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

/** A valid pinnedSpec (core components only). */
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

// The real resolved hash of the /compose request body's intent ({canonical:"sales.trend", params:{}}) --
// resolveIntent always re-derives via finalizeIntent regardless of what stubSemantic.normalize returns, so
// this must match that, not a placeholder (materializeFixation now verifies fixation.intentHash against it).
const REQUEST_INTENT = await finalizeIntent({ canonical: "sales.trend", params: {} });

async function makeFixation(pinnedSpec: UISpec, catalogFingerprint: string): Promise<FixationRecord> {
  return {
    intentHash: REQUEST_INTENT.hash,
    canonical: "sales.trend",
    // The real structureHash of pinnedSpec (not a placeholder): materializeFixation now verifies this matches.
    structureHash: await computeStructureHash(pinnedSpec),
    pinnedSpec,
    fixatedAt: "2026-06-10T00:00:00Z",
    approver: { id: "tester" },
    catalogFingerprint,
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

/** A spy that records compose's recorder.composed calls (surface / tenant). */
function spyRecorder(): { api: ViewRecorder; composed: { surface: string; tenant?: string }[] } {
  const composed: { surface: string; tenant?: string }[] = [];
  return {
    composed,
    api: {
      async composed(args) {
        composed.push({ surface: args.surface, ...(args.tenant != null ? { tenant: args.tenant } : {}) });
      },
      async interacted() {},
    },
  };
}

function makeDeps(overrides: Partial<KohakuHostDeps>): KohakuHostDeps {
  return {
    compose: composeCtx(),
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    // Same as the demo: resolve the x-kohaku-tenant header to the tenant.
    tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
    ...overrides,
  };
}

function composeReq(tenant?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(tenant != null ? { "x-kohaku-tenant": tenant } : {}),
    },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  };
}

describe("tenant contract (host-rest)", () => {
  it("compose with the x-kohaku-tenant header passes tenant to recorder.composed", async () => {
    const recorder = spyRecorder();
    const app = createKohakuRoutes(makeDeps({ recorder: recorder.api }));

    const res = await app.request("/compose", composeReq("acme"));
    expect(res.status).toBe(200);
    expect(recorder.composed).toHaveLength(1);
    expect(recorder.composed[0]!.tenant).toBe("acme");
  });

  it("without the header, tenant is not carried (single-tenant-equivalent regression)", async () => {
    const recorder = spyRecorder();
    const app = createKohakuRoutes(makeDeps({ recorder: recorder.api }));

    const res = await app.request("/compose", composeReq());
    expect(res.status).toBe(200);
    expect(recorder.composed[0]!.tenant).toBeUndefined();
  });

  it("fixationLookup receives a SessionContext (with tenant) and can deliver fixations per tenant", async () => {
    const seen: (SessionContext | undefined)[] = [];
    // Return a fixation only for tenant "acme" (other tenants -> null -> fall back to normal compose).
    const fixationLookup = async (
      _intentHash: string,
      session: SessionContext,
    ): Promise<FixationRecord | null> => {
      seen.push(session);
      return session.tenant === "acme" ? await makeFixation(validPinned(), catalog.fingerprint) : null;
    };
    const app = createKohakuRoutes(makeDeps({ fixationLookup }));

    // acme: the fixation is delivered (provenance.cache = "fixated").
    const acme = (await (await app.request("/compose", composeReq("acme"))).json()) as { spec: UISpec };
    expect(acme.spec.provenance.cache).toBe("fixated");

    // globex: no fixation -> normal compose (fallback L0).
    const globex = (await (await app.request("/compose", composeReq("globex"))).json()) as {
      spec: UISpec;
    };
    expect(globex.spec.provenance.cache).not.toBe("fixated");

    // fixationLookup receives the session each time, and tenant is propagated.
    expect(seen.map((s) => s?.tenant)).toEqual(["acme", "globex"]);
  });
});

/** A storage whose listLineage can filter by tenant (for verifying GET /lineage's audit-plane tenant filtering). */
function lineageStorage(events: LineageEventRecord[]): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage(filter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      // When tenant is specified, only matching events (unspecified = all = legacy behavior).
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      return result.slice(-(filter.limit ?? 200));
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

/** deps for GET /lineage. When opts.tenant=false, deps.tenant is not wired (equivalent to single tenant). */
function lineageDeps(events: LineageEventRecord[], opts: { tenant: boolean }): KohakuHostDeps {
  return {
    compose: { ...composeCtx(), storage: lineageStorage(events) },
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    ...(opts.tenant ? { tenant: (c) => c.req.header("x-kohaku-tenant") || undefined } : {}),
  };
}

let levSeq = 0;

function lev(type: string, tenant?: string): LineageEventRecord {
  return {
    id: `${type}:${tenant ?? ""}:${++levSeq}`,
    ts: "2026-06-10T00:00:00Z",
    actor: { kind: "system" },
    type,
    payload: {},
    ...(tenant != null ? { tenant } : {}),
  };
}

describe("View Lineage audit-plane tenant filtering (GET /lineage)", () => {
  it("tenant A's request does not include tenant B's events (filtered by session-derived tenant)", async () => {
    const events = [
      lev("view.composed", "acme"),
      lev("view.composed", "acme"),
      lev("view.composed", "globex"),
    ];
    const app = createKohakuRoutes(lineageDeps(events, { tenant: true }));

    const res = await app.request("/lineage", { headers: { "x-kohaku-tenant": "acme" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: LineageEventRecord[] };
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e) => e.tenant === "acme")).toBe(true);
  });

  it("a host with no tenant configured returns events for all tenants (legacy-behavior regression)", async () => {
    const events = [lev("view.composed", "acme"), lev("view.composed", "globex")];
    // deps.tenant not wired. Even with a header it is not resolved, so no filtering.
    const app = createKohakuRoutes(lineageDeps(events, { tenant: false }));

    const res = await app.request("/lineage", { headers: { "x-kohaku-tenant": "acme" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: LineageEventRecord[] };
    expect(body.events).toHaveLength(2);
  });
});

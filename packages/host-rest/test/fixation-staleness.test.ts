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
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type FixationsApi, type KohakuHostDeps } from "../src/index.js";

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

function composeCtx(): ComposeContext {
  return {
    catalog,
    semantic: stubSemantic(),
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: { fixedSpecs: { lookup: async () => fallbackFixed() } },
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

async function makeFixation(pinnedSpec: UISpec, catalogFingerprint?: string): Promise<FixationRecord> {
  return {
    intentHash: REQUEST_INTENT.hash,
    canonical: "sales.trend",
    // The real structureHash of pinnedSpec (not a placeholder): materializeFixation now verifies this
    // matches, and different tests below pass differently-shaped pinnedSpec content.
    structureHash: await computeStructureHash(pinnedSpec),
    pinnedSpec,
    fixatedAt: "2026-06-10T00:00:00Z",
    approver: { id: "tester" },
    ...(catalogFingerprint != null ? { catalogFingerprint } : {}),
  };
}

/** A spy that records invalidate / refreshFingerprint calls. */
function spyFixations(): {
  api: FixationsApi;
  invalidate: {
    intentHash: string;
    reason: string;
    detail?: string;
    guard?: { ifCatalogFingerprint?: string; ifFixatedAt?: string };
  }[];
  refresh: { intentHash: string; fp: string }[];
} {
  const invalidate: {
    intentHash: string;
    reason: string;
    detail?: string;
    guard?: { ifCatalogFingerprint?: string; ifFixatedAt?: string };
  }[] = [];
  const refresh: { intentHash: string; fp: string }[] = [];
  return {
    invalidate,
    refresh,
    api: {
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
      async invalidate(intentHash, reason, options) {
        invalidate.push({
          intentHash,
          reason,
          ...(options?.detail != null ? { detail: options.detail } : {}),
          ...(options?.guard != null ? { guard: options.guard } : {}),
        });
      },
      async refreshFingerprint(intentHash, fp) {
        refresh.push({ intentHash, fp });
      },
    },
  };
}

function deps(fixation: FixationRecord, fixations: FixationsApi): KohakuHostDeps {
  return {
    compose: composeCtx(),
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    fixationLookup: async () => fixation,
    fixations,
  };
}

async function postCompose(hostDeps: KohakuHostDeps): Promise<{ spec: UISpec }> {
  const app = createKohakuRoutes(hostDeps);
  const res = await app.request("/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { spec: UISpec };
}

describe("staleness detection of fixation (host-rest /compose)", () => {
  it("fresh (fingerprint match) delivers the fixation and does not call invalidate/refresh", async () => {
    const spy = spyFixations();
    const fixation = await makeFixation(validPinned(), catalog.fingerprint);
    const body = await postCompose(deps(fixation, spy.api));

    expect(body.spec.provenance.cache).toBe("fixated");
    expect(spy.invalidate).toHaveLength(0);
    expect(spy.refresh).toHaveLength(0);
  });

  it("revalidated (fingerprint mismatch + validation passes) delivers and calls refreshFingerprint", async () => {
    const spy = spyFixations();
    const fixation = await makeFixation(validPinned(), "sha256:stale-fp");
    const body = await postCompose(deps(fixation, spy.api));

    expect(body.spec.provenance.cache).toBe("fixated");
    expect(spy.invalidate).toHaveLength(0);
    expect(spy.refresh).toHaveLength(1);
    expect(spy.refresh[0]!.fp).toBe(catalog.fingerprint);
  });

  it("stale (validation fails) calls invalidate and falls back to normal compose", async () => {
    const spy = spyFixations();
    const stalePinned = validPinned();
    stalePinned.components = [
      { id: "root", type: "layout.stack", props: {}, children: ["ghost"] },
      { id: "ghost", type: "was.promoted.but.removed", props: {} },
    ];
    const fixation = await makeFixation(stalePinned, "sha256:stale-fp");
    const body = await postCompose(deps(fixation, spy.api));

    // The fixation is not delivered; normal compose (fallback L0) is returned.
    expect(body.spec.provenance.cache).not.toBe("fixated");
    expect(body.spec.components.some((c) => c.type === "presentMarkdown")).toBe(true);
    expect(spy.invalidate).toHaveLength(1);
    expect(spy.invalidate[0]!.reason).toBe("stale");
    expect(spy.invalidate[0]!.detail).toContain("ghost");
    // Pass the fixation's fixatedAt and fingerprint at the time stale was judged as a guard (conditional
    // deletion so a new fixation re-approved after the judgment is not deleted by mistake. TOCTOU guard).
    expect(spy.invalidate[0]!.guard).toEqual({
      ifFixatedAt: fixation.fixatedAt,
      ifCatalogFingerprint: "sha256:stale-fp",
    });
    expect(spy.refresh).toHaveLength(0);
  });

  it("drift-stale (resolved-URI set drifts even with a fingerprint match) calls invalidate('stale') and falls back to normal compose", async () => {
    const spy = spyFixations();
    // At fixation time 2 refs were resolved (REF + an old URI), but the stub's resolveQuery returns only the current REF.
    // Keep the fingerprint matching (fresh path) to show it goes stale purely from drift in the resolved-URI set, not a validate failure.
    const legacy = "query://sales/legacy?fy=2025&groupBy=region";
    const driftPinned: UISpec = {
      ...validPinned(),
      refVersions: { [REF]: "sales@v0", [legacy]: "sales@v0" },
    };
    const fixation = await makeFixation(driftPinned, catalog.fingerprint);
    const body = await postCompose(deps(fixation, spy.api));

    // The fixation is not delivered; normal compose (fallback L0) is returned.
    expect(body.spec.provenance.cache).not.toBe("fixated");
    expect(body.spec.components.some((c) => c.type === "presentMarkdown")).toBe(true);
    expect(spy.invalidate).toHaveLength(1);
    expect(spy.invalidate[0]!.reason).toBe("stale");
    // The directional message from #22 (including the disappeared URI) flows into invalidate's detail as-is.
    expect(spy.invalidate[0]!.detail).toContain(legacy);
    expect(spy.refresh).toHaveLength(0);
  });
});

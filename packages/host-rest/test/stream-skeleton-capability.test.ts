import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  QueryHandle,
  Scope,
  SemanticPort,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// The streaming skeleton (a non-final `spec` event) has no $ref yet, so /compose/stream issues its capability
// from composeStream's resolved refs (host-core's issueCapabilityForRefs) instead of from the Spec. This pins
// the end-to-end contract: the capability delivered on the skeleton event covers exactly `ev.refs` for
// /binding/resolve, and nothing else. The L1 generation is driven by FakeLlm (no real LLM).

const catalog = resolveCatalog(coreCatalog);

const SUMMARY_REF = "query://sales/summary?fy=2026&groupBy=region";
const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";
const UNRELATED_REF = "query://sales/kpi?fy=2026&metric=total_revenue&q=3&region=japan";

const HANDLES: QueryHandle[] = [{ uri: SUMMARY_REF }, { uri: TREND_REF }];

function stubSemantic(handles: QueryHandle[]): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.trend", params, hash: "" };
    },
    async resolveQuery() {
      return handles;
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

/** An authz that carries the scopes in base64 and matches kind+ref (exact match) in verify. */
function scopeAuthz(): { api: AuthzPort; issued: () => Scope[][] } {
  const issued: Scope[][] = [];
  return {
    issued: () => issued,
    api: {
      async issueCapability(_principal, scopes) {
        issued.push(scopes);
        return Buffer.from(JSON.stringify(scopes)).toString("base64url");
      },
      async verify(token, req) {
        const scopes = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Scope[];
        const granted = scopes.some((s) => s.kind === req.kind && req.ref === s.ref);
        return granted
          ? { ok: true, principal: { id: "u", roles: ["user"] } }
          : { ok: false, reason: `scope does not cover ${req.kind}:${req.ref}` };
      },
    },
  };
}

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke(op, args) {
    return { columns: [], rows: [], dataVersion: "sales@v1", op, args };
  },
};

function makeDeps(authz: AuthzPort): KohakuHostDeps {
  const compose: ComposeContext = {
    catalog,
    semantic: stubSemantic(HANDLES),
    storage: stubStorage(),
    // L1 generation is scripted (and invalid on purpose, so it settles on the deterministic fallback): the
    // skeleton is emitted before generation starts, which is all this test depends on.
    llm: new FakeLlm({ objects: [{ components: [], events: [] }] }),
    policy: {},
  };
  return { compose, domain, authz, querySource: "sales" };
}

type SpecEvent = { capability: string; final: boolean; spec: UISpec };

/** Every `event: spec` block of a raw SSE body, parsed. */
function specEvents(sse: string): SpecEvent[] {
  const events: SpecEvent[] = [];
  for (const block of sse.split("\n\n")) {
    if (!/(^|\n)event: spec(\n|$)/.test(block)) continue;
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (dataLine == null) continue;
    events.push(JSON.parse(dataLine.slice("data:".length).trim()) as SpecEvent);
  }
  return events;
}

async function resolveStatus(
  app: ReturnType<typeof createKohakuRoutes>,
  capability: string,
  ref: string,
): Promise<number> {
  const res = await app.request(`/binding/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${capability}` },
  });
  return res.status;
}

describe("/compose/stream: the skeleton event's capability covers exactly the resolved refs", () => {
  it("a non-final skeleton carries a read capability that resolves each of its refs (200) and nothing else (403)", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api));
    const res = await app.request("/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(res.status).toBe(200);

    const events = specEvents(await res.text());
    // L1 generation: the first spec event is the skeleton (final:false), issued before generation completes.
    const skeleton = events[0];
    expect(skeleton).toBeDefined();
    expect(skeleton!.final).toBe(false);
    expect(typeof skeleton!.capability).toBe("string");

    // Issued once, from the resolved refs: read scopes only, one per distinct ref.
    expect(authz.issued()).toHaveLength(1);
    expect(authz.issued()[0]).toEqual([
      { kind: "read", ref: SUMMARY_REF },
      { kind: "read", ref: TREND_REF },
    ]);

    expect(await resolveStatus(app, skeleton!.capability, SUMMARY_REF)).toBe(200);
    expect(await resolveStatus(app, skeleton!.capability, TREND_REF)).toBe(200);
    expect(await resolveStatus(app, skeleton!.capability, UNRELATED_REF)).toBe(403);
  });

  it("the skeleton capability is read-only: it cannot authorize a write", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api));
    const res = await app.request("/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    const skeleton = specEvents(await res.text())[0]!;

    const write = await app.request("/binding/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${skeleton.capability}` },
      body: JSON.stringify({ action: "annotate", payload: {} }),
    });
    expect(write.status).toBe(403);
  });
});

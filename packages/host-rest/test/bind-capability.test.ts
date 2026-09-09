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
import { specEventCapability } from "./helpers/sse.js";

// Capability verification for two-way binding:
// Confirms that a compose-derived capability covers data.bind's Cartesian-product variants (all combinations of
// values) with read scopes, and that only effective refs the client can reach by changing $state pass
// /binding/resolve (outside values is 403). Also pins that an effective ref with reserved params (_) is verified
// against base, and that a spec exceeding the total variant cap is rejected at compose.

const catalog = resolveCatalog(coreCatalog);

const REGIONS = ["japan", "north_america", "europe", "apac"];
// The initial variant ($ref) is region=japan. Params are in the ascending-key canonical form (fy < groupBy/metric < q < region).
const KPI_REF = "query://sales/kpi?fy=2026&metric=total_revenue&q=3&region=japan";
const SUMMARY_REF = "query://sales/summary?fy=2026&groupBy=region&q=3&region=japan";

/** A cross-filter fixed Spec of KPI + table + control.select with region bound. */
function crossFilterFixed(): UISpec {
  return {
    kohaku: "0.2",
    intent: { canonical: "sales.quarterly_summary", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    state: { region: "japan" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["filter", "kpi", "table"] },
      {
        id: "filter",
        type: "control.select",
        props: {
          label: "Region",
          value: "japan",
          options: REGIONS.map((value) => ({ value, label: value })),
        },
      },
      {
        id: "kpi",
        type: "presentMetric",
        props: { label: "Revenue", valueColumn: "revenue" },
        data: { $ref: KPI_REF, bind: { region: { $state: "region", values: REGIONS } } },
      },
      {
        id: "table",
        type: "presentSpreadsheet",
        props: { serverSide: true },
        data: { $ref: SUMMARY_REF, bind: { region: { $state: "region", values: REGIONS } } },
      },
    ],
    events: [{ on: "filter.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

/** A fixed Spec with a 257-value bind that exceeds MAX_BIND_VARIANTS (256) (to trigger the cap guard). */
function oversizedBindFixed(): UISpec {
  const values = Array.from({ length: 257 }, (_, i) => `r${i}`);
  return {
    kohaku: "0.2",
    intent: { canonical: "sales.quarterly_summary", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    state: { region: "r0" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
      {
        id: "kpi",
        type: "presentMetric",
        props: { label: "Revenue", valueColumn: "revenue" },
        data: {
          $ref: "query://sales/kpi?fy=2026&metric=total_revenue&q=3&region=r0",
          bind: { region: { $state: "region", values } },
        },
      },
    ],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function stubSemantic(handles: QueryHandle[]): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.quarterly_summary", params, hash: "" };
    },
    async resolveQuery() {
      return handles;
    },
    async dataVersion() {
      return "v42";
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
function scopeAuthz(): { api: AuthzPort; lastScopes: () => Scope[] } {
  let captured: Scope[] = [];
  return {
    lastScopes: () => captured,
    api: {
      async issueCapability(_principal, scopes) {
        captured = scopes;
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
    return { columns: [], rows: [], dataVersion: "v42", op, args };
  },
};

function makeDeps(authz: AuthzPort, fixed: UISpec, handles: QueryHandle[]): KohakuHostDeps {
  return {
    compose: {
      catalog,
      semantic: stubSemantic(handles),
      storage: stubStorage(),
      llm: new FakeLlm(),
      policy: { fixedSpecs: { lookup: async () => fixed } },
    } as ComposeContext,
    domain,
    authz,
    querySource: "sales",
  };
}

async function compose(app: ReturnType<typeof createKohakuRoutes>) {
  return app.request("/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.quarterly_summary", params: {} } }),
  });
}

async function resolve(
  app: ReturnType<typeof createKohakuRoutes>,
  capability: string,
  ref: string,
): Promise<number> {
  const res = await app.request(`/binding/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${capability}` },
  });
  return res.status;
}

function replaceRegion(ref: string, region: string): string {
  return ref.replace(/region=[^&]*/, `region=${region}`);
}

describe("bind variant enumeration of compose-derived capability", () => {
  const HANDLES: QueryHandle[] = [{ uri: KPI_REF }, { uri: SUMMARY_REF }];

  it("issues the cross-product of both $ref × all regions in the read scope (including the initial variant)", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api, crossFilterFixed(), HANDLES));
    const res = await compose(app);
    expect(res.status).toBe(200);

    const scopes = authz.lastScopes();
    const readPrefixes = scopes.filter((s) => s.kind === "read").map((s) => s.ref);
    for (const region of REGIONS) {
      expect(readPrefixes).toContain(replaceRegion(KPI_REF, region));
      expect(readPrefixes).toContain(replaceRegion(SUMMARY_REF, region));
    }
    // 2 refs x 4 regions = 8 read scopes (no duplicates).
    expect(readPrefixes).toHaveLength(8);
  });

  it("/binding/resolve returns 200 for every region variant (in-client re-resolution is authorized)", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api, crossFilterFixed(), HANDLES));
    const capability = ((await (await compose(app)).json()) as { capability: string }).capability;

    for (const region of REGIONS) {
      expect(await resolve(app, capability, replaceRegion(KPI_REF, region))).toBe(200);
      expect(await resolve(app, capability, replaceRegion(SUMMARY_REF, region))).toBe(200);
    }
  });

  it("a region outside values is not in the capability and returns 403 (no forgery)", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api, crossFilterFixed(), HANDLES));
    const capability = ((await (await compose(app)).json()) as { capability: string }).capability;

    expect(await resolve(app, capability, replaceRegion(KPI_REF, "zzz"))).toBe(403);
    expect(await resolve(app, capability, replaceRegion(SUMMARY_REF, "atlantis"))).toBe(403);
  });

  it("an effective ref with reserved parameters is verified against the base (= variant) and returns 200", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api, crossFilterFixed(), HANDLES));
    const capability = ((await (await compose(app)).json()) as { capability: string }).capability;

    // A paging request where the serverSide=true table adds _limit/_sort/_dir to the europe variant.
    const effective =
      "query://sales/summary?_dir=desc&_limit=50&_sort=amount&fy=2026&groupBy=region&q=3&region=europe";
    expect(await resolve(app, capability, effective)).toBe(200);
  });

  it("a spec whose total variant count exceeds the limit (256) is rejected at compose", async () => {
    const authz = scopeAuthz();
    const handles: QueryHandle[] = [{ uri: "query://sales/kpi?fy=2026&metric=total_revenue&q=3&region=r0" }];
    const app = createKohakuRoutes(makeDeps(authz.api, oversizedBindFixed(), handles));
    const res = await compose(app);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("COMPOSE_FAILED");
  });

  // The streaming path (final:true = L0 fixed Spec) also issues bind variants. The skeleton has no bind, only
  // ev.refs, and the final Spec's bind is not carried in L1/L2 generation (generation:excluded), so the only path
  // that needs to cover bind is the final:true one — union that final Spec's variants into ev.refs when issuing.
  it("/compose/stream (final:true) also issues every region variant in the read scope", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api, crossFilterFixed(), HANDLES));
    const res = await app.request("/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.quarterly_summary", params: {} } }),
    });
    expect(res.status).toBe(200);
    const capability = specEventCapability(await res.text());

    // The capability delivered via SSE can resolve a non-initial variant (europe).
    expect(await resolve(app, capability, replaceRegion(KPI_REF, "europe"))).toBe(200);
    expect(await resolve(app, capability, replaceRegion(SUMMARY_REF, "apac"))).toBe(200);
    expect(await resolve(app, capability, replaceRegion(KPI_REF, "zzz"))).toBe(403);
  });

  // The final:true path (composeStream's own L0-fixed-Spec match, distinct from the host-core fixation
  // shortcut) now issues from the Spec via the same collectCapabilityScopes-based rule as /compose, so an
  // oversized bind (over MAX_BIND_VARIANTS) throws there too, propagating into the route's top-level catch.
  it("/compose/stream (final:true) over the variant cap terminates with event: error COMPOSE_FAILED", async () => {
    const authz = scopeAuthz();
    const handles: QueryHandle[] = [{ uri: "query://sales/kpi?fy=2026&metric=total_revenue&q=3&region=r0" }];
    const app = createKohakuRoutes(makeDeps(authz.api, oversizedBindFixed(), handles));
    const res = await app.request("/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.quarterly_summary", params: {} } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    const dataLine = text
      .split("\n\n")
      .find((block) => /(^|\n)event: error(\n|$)/.test(block))
      ?.split("\n")
      .find((l) => l.startsWith("data:"));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice("data:".length).trim()) as { error: { code: string } };
    expect(parsed.error.code).toBe("COMPOSE_FAILED");
  });
});

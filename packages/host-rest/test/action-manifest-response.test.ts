import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  OperationDescriptor,
  QueryHandle,
  SemanticPort,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { computeSpecHash } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// The `actions` manifest carried alongside a compose response (design.md #62/#64, SPEC §6.1/§6.1.1):
// outside the UISpec itself, next to `capability`, keyed by exactly the write actions the Spec declares
// that are also real DomainPort operations.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026";

function fixedSpec(events: UISpec["events"]): UISpec {
  return {
    kohaku: "0.2",
    intent: { canonical: "sales.summary", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["table"] },
      { id: "table", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
    ],
    events,
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

const SPEC_WITH_ACTIONS = fixedSpec([
  { on: "root.annotateClick", emit: "action.invoke", payload: { action: "annotate" } },
  { on: "root.publishClick", emit: "action.invoke", payload: { action: "publish" } },
]);

const SPEC_WITHOUT_ACTIONS = fixedSpec([]);

function stubSemantic(): SemanticPort {
  return {
    async normalize() {
      return { canonical: "sales.summary", params: {}, hash: "" };
    },
    async resolveQuery() {
      return { uri: REF } as QueryHandle;
    },
    async dataVersion() {
      return "v1";
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

function domainWithOps(...ops: OperationDescriptor[]): DomainPort {
  return {
    async listOperations() {
      return ops;
    },
    async invoke(op, args) {
      return { ok: true, op, args };
    },
  };
}

function makeDeps(domain: DomainPort, fixed: UISpec, extra?: Partial<KohakuHostDeps>): KohakuHostDeps {
  return {
    compose: {
      catalog,
      semantic: stubSemantic(),
      storage: stubStorage(),
      llm: new FakeLlm(),
      policy: { fixedSpecs: { lookup: async () => fixed } },
    } as ComposeContext,
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    ...extra,
  };
}

async function postCompose(app: ReturnType<typeof createKohakuRoutes>) {
  return app.request("/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.summary", params: {} } }),
  });
}

describe("actions manifest on POST /compose", () => {
  it("includes an entry for each declared write action present in the operation index", async () => {
    const domain = domainWithOps(
      { name: "annotate", description: "d", tier: "confirm", confirmMessage: "Are you sure?" },
      { name: "publish", description: "d" },
    );
    const app = createKohakuRoutes(makeDeps(domain, SPEC_WITH_ACTIONS));
    const res = await postCompose(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions?: Record<string, unknown> };
    expect(body.actions).toEqual({
      annotate: { tier: "confirm", confirmMessage: "Are you sure?" },
      publish: { tier: "auto" },
    });
  });

  it("includes paramsSchema in the entry when the operation declares one", async () => {
    const schema = { type: "object", properties: { note: { type: "string" } } };
    const domain = domainWithOps(
      { name: "annotate", description: "d", paramsSchema: schema },
      { name: "publish", description: "d" },
    );
    const app = createKohakuRoutes(makeDeps(domain, SPEC_WITH_ACTIONS));
    const body = (await (await postCompose(app)).json()) as { actions?: Record<string, unknown> };
    expect(body.actions).toMatchObject({ annotate: { paramsSchema: schema } });
  });

  it("omits the actions field entirely when the Spec declares no write actions", async () => {
    const domain = domainWithOps({ name: "annotate", description: "d" });
    const app = createKohakuRoutes(makeDeps(domain, SPEC_WITHOUT_ACTIONS));
    const body = (await (await postCompose(app)).json()) as { actions?: unknown };
    expect(body.actions).toBeUndefined();
  });

  it("omits an action that is not a real DomainPort operation (no manifest entry, capability issuance unaffected)", async () => {
    const domain = domainWithOps(); // no operations at all
    const app = createKohakuRoutes(makeDeps(domain, SPEC_WITH_ACTIONS));
    const body = (await (await postCompose(app)).json()) as { actions?: unknown };
    expect(body.actions).toBeUndefined();
  });

  it("does not affect specHash (the manifest lives outside the Spec, next to capability)", async () => {
    const withOps = domainWithOps(
      { name: "annotate", description: "d", tier: "confirm" },
      { name: "publish", description: "d" },
    );
    const withoutOps = domainWithOps();
    const appWithManifest = createKohakuRoutes(makeDeps(withOps, SPEC_WITH_ACTIONS));
    const appWithoutManifest = createKohakuRoutes(makeDeps(withoutOps, SPEC_WITH_ACTIONS));

    const bodyWith = (await (await postCompose(appWithManifest)).json()) as { spec: UISpec };
    const bodyWithout = (await (await postCompose(appWithoutManifest)).json()) as { spec: UISpec };

    expect(await computeSpecHash(bodyWith.spec)).toBe(await computeSpecHash(bodyWithout.spec));
  });

  it("degrades gracefully (actions omitted) when listOperations() rejects, rather than failing the response", async () => {
    const seen: { endpoint: string }[] = [];
    const failingDomain: DomainPort = {
      async listOperations() {
        throw new Error("domain unavailable (test)");
      },
      async invoke(op, args) {
        return { ok: true, op, args };
      },
    };
    const app = createKohakuRoutes(
      makeDeps(failingDomain, SPEC_WITH_ACTIONS, {
        onError: (info) => {
          seen.push({ endpoint: info.endpoint });
        },
      }),
    );
    const res = await postCompose(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions?: unknown };
    expect(body.actions).toBeUndefined();
    expect(seen.some((s) => s.endpoint === "compose")).toBe(true);
  });
});

describe("actions manifest on POST /events", () => {
  it("is present on the recomposed Spec's response", async () => {
    const domain = domainWithOps({ name: "annotate", description: "d", tier: "confirm" });
    const app = createKohakuRoutes(makeDeps(domain, SPEC_WITH_ACTIONS));
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: { canonical: "sales.summary", params: {} },
        event: { on: "root.publishClick", payload: {} },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions?: Record<string, unknown> };
    expect(body.actions).toEqual({ annotate: { tier: "confirm" } });
  });
});

describe("actions manifest on POST /compose/stream", () => {
  it("is present on the event: spec payload (final:true)", async () => {
    const domain = domainWithOps(
      { name: "annotate", description: "d", tier: "confirm" },
      { name: "publish", description: "d" },
    );
    const app = createKohakuRoutes(makeDeps(domain, SPEC_WITH_ACTIONS));
    const res = await app.request("/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.summary", params: {} } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const block = text.split("\n\n").find((b) => /(^|\n)event: spec(\n|$)/.test(b));
    expect(block).toBeDefined();
    const dataLine = block!.split("\n").find((l) => l.startsWith("data:"));
    const parsed = JSON.parse(dataLine!.slice("data:".length).trim()) as {
      actions?: Record<string, unknown>;
    };
    expect(parsed.actions).toEqual({ annotate: { tier: "confirm" }, publish: { tier: "auto" } });
  });
});

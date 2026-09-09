import type { ComposeContext } from "@kohaku-ui/composer";
import { WriteScopeDroppedError } from "@kohaku-ui/host-core";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, Scope, SemanticPort, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";
import { specEventCapability } from "./helpers/sse.js";

// Write-scope verification of a compose-derived capability:
// Confirms that the capability covers the action.invoke declared by the composed UI (presentForm submit /
// action.button), and that /binding/action (the write-through path) can be fired with that capability (symmetric with read's $ref).

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/records?fy=2026";

/** A fixed Spec with presentForm (action=annotate) + a separate table + an action.invoke event. */
function writeLoopFixed(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.records", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "ignored",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1", "t1"] },
      {
        id: "f1",
        type: "presentForm",
        props: { action: "annotate", fields: [{ name: "note", type: "text", label: "Note" }] },
      },
      { id: "t1", type: "presentSpreadsheet", props: { editable: false }, data: { $ref: REF } },
    ],
    events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value.note", refs: [REF] } }],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function stubSemantic(): SemanticPort {
  return {
    async normalize(input) {
      const params = input.kind === "nl" ? {} : { ...(input.current?.params ?? {}), ...input.params };
      return { canonical: "sales.records", params, hash: "" };
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

/** An authz with scope checking (records the issued scopes and matches kind+ref by exact match in verify). */
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
    return [{ name: "annotate", description: "write" }];
  },
  async invoke(op, args) {
    return { ok: true, op, args };
  },
};

function makeDeps(
  authz: AuthzPort,
  options?: { domain?: DomainPort; onError?: (info: { endpoint: string; error: unknown }) => void },
): KohakuHostDeps {
  return {
    compose: {
      catalog,
      semantic: stubSemantic(),
      storage: stubStorage(),
      llm: new FakeLlm(),
      policy: { fixedSpecs: { lookup: async () => writeLoopFixed() } },
    } as ComposeContext,
    domain: options?.domain ?? domain,
    authz,
    querySource: "sales",
    actionEffects: async (_action, payload) => ({ invalidates: (payload["refs"] as string[]) ?? [] }),
    ...(options?.onError != null ? { onError: options.onError } : {}),
  };
}

async function compose(app: ReturnType<typeof createKohakuRoutes>): Promise<string> {
  const res = await app.request("/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.records", params: {} } }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { capability: string }).capability;
}

describe("write scope of compose-derived capability (write loop)", () => {
  it("issues a write scope for the declared action.invoke action and a read scope for the $ref", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api));
    await compose(app);

    const scopes = authz.lastScopes();
    expect(scopes).toContainEqual({ kind: "read", ref: REF });
    expect(scopes).toContainEqual({ kind: "write", ref: "annotate" });
  });

  it("with a compose-derived capability, /binding/action (annotate) returns 200 (not read-only)", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api));
    const capability = await compose(app);

    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "annotate", payload: { note: "hi", refs: [REF] } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean }; invalidates: string[] };
    expect(body.result.ok).toBe(true);
    expect(body.invalidates).toEqual([REF]);
  });

  it("an undeclared action is outside the write scope and returns 403 (no over-granting)", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api));
    const capability = await compose(app);

    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "deleteEverything", payload: {} }),
    });
    expect(res.status).toBe(403);
  });
});

describe("write scopes are restricted to DomainPort operations", () => {
  it("an action.invoke whose action is not a DomainPort operation gets no write scope and onError is notified (endpoint compose)", async () => {
    const authz = scopeAuthz();
    const seen: { endpoint: string; error: unknown }[] = [];
    const noAnnotateDomain: DomainPort = {
      async listOperations() {
        return [];
      },
      async invoke(op, args) {
        return { ok: true, op, args };
      },
    };
    const app = createKohakuRoutes(
      makeDeps(authz.api, {
        domain: noAnnotateDomain,
        onError: (info) => seen.push(info),
      }),
    );
    const capability = await compose(app);

    const scopes = authz.lastScopes();
    expect(scopes).toContainEqual({ kind: "read", ref: REF });
    expect(scopes).not.toContainEqual({ kind: "write", ref: "annotate" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("compose");
    expect(seen[0]!.error).toBeInstanceOf(WriteScopeDroppedError);

    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "annotate", payload: { note: "hi", refs: [REF] } }),
    });
    expect(res.status).toBe(403);
  });

  it("/compose/stream final:true (L0 fixed Spec) carries the write scope and /binding/action returns 200", async () => {
    const authz = scopeAuthz();
    const app = createKohakuRoutes(makeDeps(authz.api));
    const res = await app.request("/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.records", params: {} } }),
    });
    expect(res.status).toBe(200);
    const capability = specEventCapability(await res.text());

    const scopes = authz.lastScopes();
    expect(scopes).toContainEqual({ kind: "write", ref: "annotate" });

    const actionRes = await app.request("/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "annotate", payload: { note: "hi", refs: [REF] } }),
    });
    expect(actionRes.status).toBe(200);
  });

  it("when listOperations rejects, the capability is issued read-only and onError is notified", async () => {
    const authz = scopeAuthz();
    const seen: { endpoint: string; error: unknown }[] = [];
    const failingDomain: DomainPort = {
      async listOperations() {
        throw new Error("domain unavailable");
      },
      async invoke(op, args) {
        return { ok: true, op, args };
      },
    };
    const app = createKohakuRoutes(
      makeDeps(authz.api, { domain: failingDomain, onError: (info) => seen.push(info) }),
    );
    const capability = await compose(app);

    const scopes = authz.lastScopes();
    expect(scopes).toContainEqual({ kind: "read", ref: REF });
    expect(scopes).not.toContainEqual({ kind: "write", ref: "annotate" });
    expect(seen.some((s) => s.endpoint === "compose" && s.error instanceof Error)).toBe(true);

    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "annotate", payload: { note: "hi", refs: [REF] } }),
    });
    expect(res.status).toBe(403);
  });
});

import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type {
  AuthzPort,
  DomainPort,
  SemanticPort,
  SessionContext,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// session.locale wire acceptance (additive): the optional locale tag on the session body must be
// threaded through toSession into SessionContext.locale so SemanticPort.normalize (and any
// composer policyFor hook) can observe it. Absent locale keeps the legacy SessionContext shape.

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

/** A SemanticPort that records the SessionContext it was normalized with. */
function capturingSemantic(seen: SessionContext[]): SemanticPort {
  return {
    async normalize(_input, ctx) {
      seen.push(ctx);
      return { canonical: "sales.trend", params: {}, hash: "" };
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

function makeDeps(semantic: SemanticPort): KohakuHostDeps {
  const compose: ComposeContext = {
    catalog,
    semantic,
    storage: stubStorage(),
    llm: new FakeLlm(),
    policy: {},
  };
  return { compose, domain, authz: allowAuthz(), querySource: "sales" };
}

function normalizeReq(session: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { kind: "nl", text: "show the trend" },
      ...(session != null ? { session } : {}),
    }),
  };
}

describe("POST /intent/normalize: session.locale", () => {
  it("threads session.locale into SessionContext.locale for SemanticPort.normalize", async () => {
    const seen: SessionContext[] = [];
    const app = createKohakuRoutes(makeDeps(capturingSemantic(seen)));
    const res = await app.request("/intent/normalize", normalizeReq({ surface: "web", locale: "ja" }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.locale).toBe("ja");
  });

  it("omits locale from SessionContext when the body does not carry it (legacy shape)", async () => {
    const seen: SessionContext[] = [];
    const app = createKohakuRoutes(makeDeps(capturingSemantic(seen)));
    const res = await app.request("/intent/normalize", normalizeReq({ surface: "web" }));
    expect(res.status).toBe(200);
    expect("locale" in seen[0]!).toBe(false);
  });

  it("rejects a non-string locale with 400 BAD_REQUEST", async () => {
    const app = createKohakuRoutes(makeDeps(capturingSemantic([])));
    const res = await app.request("/intent/normalize", normalizeReq({ surface: "web", locale: 42 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /compose: session.locale", () => {
  it("reaches the composer session (observable via SemanticPort.normalize on the compose path)", async () => {
    const seen: SessionContext[] = [];
    const app = createKohakuRoutes(makeDeps(capturingSemantic(seen)));
    const res = await app.request("/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: { kind: "nl", text: "show the trend" },
        session: { surface: "web", locale: "ja" },
      }),
    });
    expect(res.status).toBe(200);
    expect(seen.some((s) => s.locale === "ja")).toBe(true);
  });
});

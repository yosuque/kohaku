import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, SemanticPort, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";
import { COMPOSE_FAILED_MESSAGE } from "../src/routes/compose.js";

// §4.5 R2: /compose/stream must not treat a client disconnect as a generation failure — it must not call
// onError, and must not attempt to write an `event: error` onto an already-closed stream (a raw exception's
// message must also stay masked on the ordinary, non-disconnected failure path — §2 #8's SSE COMPOSE_FAILED
// gating, tested here as the control case).

const catalog = resolveCatalog(coreCatalog);
const REF = "query://sales/summary?fy=2026&groupBy=region";

function okSemantic(): SemanticPort {
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

/** A StoragePort whose getSpecCache always throws a raw (untyped) Error. Combined with
 * policy.cacheFailure:"closed" below, this rethrows unwrapped through prepareCompose (composer's own
 * fail-open cache-lookup wrapper otherwise swallows a cache-backend failure as a miss), giving a "hard"
 * composeStream failure that is genuinely untyped (not a SpecError/ComposeError), unlike a semantic.resolveQuery
 * failure (which the composer wraps into a typed ComposeError before it ever reaches host-rest). */
function failingStorage(): StoragePort {
  return {
    async getSpecCache(): Promise<never> {
      throw new Error("secret storage backend detail");
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

function makeDeps(onError?: KohakuHostDeps["onError"]): KohakuHostDeps {
  const compose: ComposeContext = {
    catalog,
    semantic: okSemantic(),
    storage: failingStorage(),
    llm: new FakeLlm(),
    policy: { cacheFailure: "closed" },
  };
  return {
    compose,
    domain,
    authz: allowAuthz(),
    querySource: "sales",
    ...(onError != null ? { onError } : {}),
  };
}

function streamReq(signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    ...(signal != null ? { signal } : {}),
  };
}

describe("/compose/stream disconnect handling", () => {
  it("an already-aborted request neither calls onError nor writes event: error", async () => {
    const seen: string[] = [];
    const deps = makeDeps((info) => {
      seen.push(info.endpoint);
    });
    const app = createKohakuRoutes(deps);

    const controller = new AbortController();
    controller.abort(); // the client is already gone before the handler observes the failure

    const res = await app.request("/compose/stream", streamReq(controller.signal));
    // SSE headers are already committed by the time the failure surfaces, so the HTTP status is still 200.
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).not.toContain("event: error");
    expect(seen).not.toContain("compose/stream");
  });

  it("control: a non-disconnected failure still reports to onError and masks the raw message in event: error", async () => {
    const seen: { endpoint: string; error: unknown }[] = [];
    const deps = makeDeps((info) => {
      seen.push({ endpoint: info.endpoint, error: info.error });
    });
    const app = createKohakuRoutes(deps);

    const res = await app.request("/compose/stream", streamReq());
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain("event: error");
    const dataLine = text
      .split("\n\n")
      .find((block) => /(^|\n)event: error(\n|$)/.test(block))
      ?.split("\n")
      .find((l) => l.startsWith("data:"));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice("data:".length).trim()) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("COMPOSE_FAILED");
    // The raw exception's message never reaches the client; it collapses to the fixed text.
    expect(parsed.error.message).toBe(COMPOSE_FAILED_MESSAGE);
    expect(parsed.error.message).not.toContain("secret storage backend detail");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.endpoint).toBe("compose/stream");
    expect(seen[0]!.error).toBeInstanceOf(Error);
  });
});

import type { ComposeContext } from "@kohaku-ui/composer";
import { STORAGE_CONFLICT_MESSAGE } from "@kohaku-ui/host-core";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  type DomainPort,
  type Scope,
  type SemanticPort,
  StorageConflictError,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer } from "../src/index.js";

// A StorageConflictError (a StoragePort compare-and-set that lost a race with another host instance) reaching a
// tool boundary must answer a structured tool error carrying the fixed STORAGE_CONFLICT_MESSAGE -- never the
// error's own text (which names the record kind and key) -- and the original error must still reach onError.

const REF = "query://sales/summary?fy=2026&groupBy=region";
const authz: AuthzPort = {
  async issueCapability(_p, scopes: Scope[]) {
    return `cap:${scopes.map((s) => s.ref).join("|")}`;
  },
  async verify() {
    return { ok: true, principal: { id: "tester" } };
  },
};

const domain: DomainPort = {
  async listOperations() {
    return [];
  },
  async invoke() {
    return { columns: [], rows: [], dataVersion: "sales@seed-1" };
  },
};

function failingSemantic(error: Error): SemanticPort {
  return {
    async normalize() {
      throw error;
    },
    async resolveQuery() {
      return { uri: REF };
    },
    async dataVersion() {
      return "sales@seed-1";
    },
  };
}

function makeComposeCtx(semantic: SemanticPort): ComposeContext {
  const cache = new Map<string, UISpec>();
  return {
    catalog: resolveCatalog(coreCatalog),
    llm: {
      provider: "fake",
      modelId: "fake",
      async generateObject() {
        throw new Error("LLM is not called");
      },
      async generateText() {
        throw new Error("no");
      },
    },
    semantic,
    storage: {
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
    },
    policy: {},
  };
}

async function connect(error: Error): Promise<{ client: Client; onError: ReturnType<typeof vi.fn> }> {
  const onError = vi.fn();
  const server = new McpServer({ name: "kohaku-llm-unavailable-test", version: "0.1.0" });
  attachKohakuToMcpServer(
    server,
    { compose: makeComposeCtx(failingSemantic(error)), domain, authz, querySource: "sales", onError },
    { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>" },
  );
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, onError };
}

describe("a storage compare-and-set conflict is a structured tool error with the fixed message", () => {
  it("kohaku_compose answers STORAGE_CONFLICT_MESSAGE and reports the original error", async () => {
    const error = new StorageConflictError("fixation", "intent-secret-hash");
    const { client, onError } = await connect(error);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toBe(STORAGE_CONFLICT_MESSAGE);
    expect(text).not.toContain("secret");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error }));
  });
});

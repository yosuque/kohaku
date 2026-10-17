import type { ComposeContext } from "@kohaku-ui/composer";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import {
  type AuthzPort,
  computeStructureHash,
  type DomainPort,
  type FixationRecord,
  finalizeIntent,
  type JsonObject,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// Characterization of the fixation lock the MCP profile wires today: self-healing's fire-and-forget
// refreshFingerprint (fired by kohaku_compose when a fixation's catalog fingerprint is stale but its pinned Spec
// still validates) is serialized per intentHash, and the mutex lives per `deps` object -- so two McpServers
// attached with the SAME deps object share it, while a different deps object does not. These pin what the code
// does, so the host-core extraction of the fixation host wiring must keep them green.

const catalog = resolveCatalog(coreCatalog);
const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

const authz: AuthzPort = {
  async issueCapability() {
    return "cap";
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
    return {};
  },
};

/** Each question normalizes to its own intent (params.q), so two questions have two intentHashes. */
function composeCtx(): ComposeContext {
  return {
    catalog,
    llm: {
      provider: "fake",
      modelId: "fake",
      async generateObject() {
        throw new Error("LLM should not be called (the fixation is always delivered)");
      },
      async generateText() {
        throw new Error("LLM should not be called (the fixation is always delivered)");
      },
    },
    semantic: {
      async normalize(input) {
        const params: JsonObject = input.kind === "nl" ? { q: input.text } : {};
        return { canonical: "sales.trend", params, hash: "" };
      },
      async resolveQuery() {
        return { uri: TREND_REF };
      },
      async dataVersion() {
        return "sales@seed-1";
      },
    },
    storage: {
      async getSpecCache() {
        return null;
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
    },
    policy: {},
  };
}

function pinnedSpec(): UISpec {
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

/** A fixation whose catalog fingerprint differs from the current catalog: delivered, and refreshFingerprint fires. */
async function staleFingerprintFixation(question: string): Promise<FixationRecord> {
  const spec = pinnedSpec();
  const intent = await finalizeIntent({ canonical: "sales.trend", params: { q: question } });
  return {
    intentHash: intent.hash,
    canonical: "sales.trend",
    structureHash: await computeStructureHash(spec),
    pinnedSpec: spec,
    fixatedAt: "2026-06-10T00:00:00Z",
    approver: { id: "tester" },
    catalogFingerprint: "sha256:stale-fp",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * deps whose first refreshFingerprint call stays pending until `release()` (every later call resolves
 * immediately). `order` records `<enter|exit>:<question>` for each call, in the order they happen.
 */
async function pendingRefreshDeps(questions: string[]): Promise<{
  deps: McpHostDeps;
  order: string[];
  release: () => void;
}> {
  const byHash = new Map<string, { question: string; fixation: FixationRecord }>();
  for (const question of questions) {
    const fixation = await staleFingerprintFixation(question);
    byHash.set(fixation.intentHash, { question, fixation });
  }
  const order: string[] = [];
  const gate = deferred();
  let calls = 0;
  const deps: McpHostDeps = {
    compose: composeCtx(),
    domain,
    authz,
    querySource: "sales",
    fixationLookup: async (intentHash) => byHash.get(intentHash)?.fixation ?? null,
    fixations: {
      async refreshFingerprint(intentHash) {
        calls += 1;
        const question = byHash.get(intentHash)!.question;
        order.push(`enter:${question}`);
        if (calls === 1) await gate.promise;
        order.push(`exit:${question}`);
      },
    },
  };
  return { deps, order, release: gate.resolve };
}

async function connect(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-fixation-lock", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "fixation-lock-client", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function compose(client: Client, question: string): Promise<void> {
  const result = await client.callTool({ name: "kohaku_compose", arguments: { question } });
  expect(result.isError).toBeFalsy();
}

describe("the fixation lock serializes self-heal per intentHash (host-mcp-apps)", () => {
  it("two concurrent kohaku_compose calls on one attached server with the same intentHash serialize their refreshFingerprint", async () => {
    const { deps, order, release } = await pendingRefreshDeps(["A"]);
    const client = await connect(deps);

    await compose(client, "A");
    await vi.waitFor(() => expect(order).toEqual(["enter:A"]));
    // The second call is delivered (self-heal is fire-and-forget) but its refreshFingerprint queues behind the first.
    await compose(client, "A");
    await tick();
    expect(order).toEqual(["enter:A"]);

    release();
    await vi.waitFor(() => expect(order).toEqual(["enter:A", "exit:A", "enter:A", "exit:A"]));
  });

  it("different intentHashes do not serialize: the second refreshFingerprint enters while the first is pending", async () => {
    const { deps, order, release } = await pendingRefreshDeps(["A", "B"]);
    const client = await connect(deps);

    await compose(client, "A");
    await vi.waitFor(() => expect(order).toEqual(["enter:A"]));
    await compose(client, "B");
    await vi.waitFor(() => expect(order).toEqual(["enter:A", "enter:B", "exit:B"]));

    release();
    await vi.waitFor(() => expect(order).toEqual(["enter:A", "enter:B", "exit:B", "exit:A"]));
  });

  it("two McpServers attached with the SAME deps object share the lock (it is scoped per deps object)", async () => {
    const { deps, order, release } = await pendingRefreshDeps(["A"]);
    const first = await connect(deps);
    const second = await connect(deps);

    await compose(first, "A");
    await vi.waitFor(() => expect(order).toEqual(["enter:A"]));
    await compose(second, "A");
    await tick();
    expect(order).toEqual(["enter:A"]);

    release();
    await vi.waitFor(() => expect(order).toEqual(["enter:A", "exit:A", "enter:A", "exit:A"]));
  });

  it("two McpServers attached with different deps objects do not share the lock", async () => {
    const { deps, order, release } = await pendingRefreshDeps(["A"]);
    const first = await connect(deps);
    const second = await connect({ ...deps });

    await compose(first, "A");
    await vi.waitFor(() => expect(order).toEqual(["enter:A"]));
    await compose(second, "A");
    await vi.waitFor(() => expect(order).toEqual(["enter:A", "enter:A", "exit:A"]));

    release();
    await vi.waitFor(() => expect(order).toEqual(["enter:A", "enter:A", "exit:A", "exit:A"]));
  });
});

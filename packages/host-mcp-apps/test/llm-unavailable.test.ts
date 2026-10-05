import type { ComposeContext } from "@kohaku-ui/composer";
import { LLM_PROVIDER_UNAVAILABLE_MESSAGE } from "@kohaku-ui/host-core";
import { LlmError, type LlmErrorCode } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { AuthzPort, DomainPort, Scope, SemanticPort, UISpec } from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer } from "../src/index.js";
import { __getTaskStoreForTest } from "../src/server.js";
import { sendRawModern, taskExtensionEnvelope } from "./connect-modern.js";

// When the LLM provider cannot serve Intent resolution (no API key, provider failure, abort), the MCP tool
// must answer a structured tool error carrying the fixed message -- never the provider SDK's raw wording --
// and the original LlmError must still reach onError.

const REF = "query://sales/summary?fy=2026&groupBy=region";
const RAW_SDK_MESSAGE =
  "[claude/claude-sonnet-5] Anthropic API key is missing. Pass it using the 'apiKey' parameter or the ANTHROPIC_API_KEY environment variable.";

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

describe("an unavailable LLM provider during Intent resolution is a structured tool error with a fixed message", () => {
  for (const code of ["PROVIDER", "CONFIG", "ABORTED"] as const satisfies LlmErrorCode[]) {
    it(`kohaku_compose (nl) with LlmError ${code} returns the fixed message and reports the original error`, async () => {
      const error = new LlmError(code, RAW_SDK_MESSAGE);
      const { client, onError } = await connect(error);

      const result = await client.callTool({
        name: "kohaku_compose",
        arguments: { question: "Monthly revenue trend" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(text).toBe(LLM_PROVIDER_UNAVAILABLE_MESSAGE);
      expect(text).not.toContain("API key");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error }));
    });
  }

  it("an LlmError INVALID_OUTPUT does not leak its raw wording either (generic tool error)", async () => {
    const { client } = await connect(new LlmError("INVALID_OUTPUT", RAW_SDK_MESSAGE));

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).not.toContain("API key");
    expect(text).not.toBe(LLM_PROVIDER_UNAVAILABLE_MESSAGE);
  });

  it("a typed error (string code) keeps passing its own message through", async () => {
    const typed = Object.assign(new Error("no intent matches the question"), { code: "NO_MATCH" });
    const { client } = await connect(typed);

    const result = await client.callTool({
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { type: string; text: string }[])[0]!.text).toBe(
      "no intent matches the question",
    );
  });
});

/**
 * Starts a task-backed `kohaku_compose` (tasksEnabled on, request declares the extension) whose Intent
 * resolution throws `error`, waits for the background compose to settle, and returns the stored task.
 * `tasks/get` itself is unreachable on the installed SDK (see tasks.test.ts), so the task is read from the
 * store directly -- the same object a `tasks/get` handler would serialize to the client.
 */
async function failedTaskFor(error: Error): Promise<{
  task: ReturnType<NonNullable<ReturnType<typeof __getTaskStoreForTest>>["get"]>;
  onError: ReturnType<typeof vi.fn>;
}> {
  const onError = vi.fn();
  const server = new McpServer({ name: "kohaku-llm-unavailable-tasks-test", version: "0.1.0" });
  attachKohakuToMcpServer(
    server,
    { compose: makeComposeCtx(failingSemantic(error)), domain, authz, querySource: "sales", onError },
    { rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>", tasksEnabled: true },
  );
  const { json } = await sendRawModern(() => server, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "kohaku_compose",
      arguments: { question: "Monthly revenue trend" },
      _meta: taskExtensionEnvelope(),
    },
  });
  const result = json["result"] as Record<string, unknown>;
  expect(result["resultType"]).toBe("task");
  const store = __getTaskStoreForTest(server)!;
  for (let i = 0; i < 50 && store.get(result["taskId"] as string)?.status === "working"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { task: store.get(result["taskId"] as string), onError };
}

describe("an unavailable LLM provider inside a task-backed kohaku_compose fails the task with the same fixed message", () => {
  for (const code of ["PROVIDER", "CONFIG", "ABORTED"] as const satisfies LlmErrorCode[]) {
    it(`LlmError ${code}: the failed task carries the fixed message, not the SDK wording, and onError gets the original error`, async () => {
      const error = new LlmError(code, RAW_SDK_MESSAGE);
      const { task, onError } = await failedTaskFor(error);

      expect(task?.status).toBe("failed");
      const message = (task as { error?: { message?: string } }).error?.message;
      expect(message).toBe(LLM_PROVIDER_UNAVAILABLE_MESSAGE);
      expect(message).not.toContain("API key");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error }));
    });
  }

  it("an untyped error collapses to the generic message instead of its own wording", async () => {
    const { task } = await failedTaskFor(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

    expect(task?.status).toBe("failed");
    const message = (task as { error?: { message?: string } }).error?.message;
    expect(message).not.toContain("ECONNREFUSED");
    expect(message).not.toBe(LLM_PROVIDER_UNAVAILABLE_MESSAGE);
  });

  it("a typed error (string code) keeps passing its own message through", async () => {
    const typed = Object.assign(new Error("no intent matches the question"), { code: "NO_MATCH" });
    const { task } = await failedTaskFor(typed);

    expect(task?.status).toBe("failed");
    expect((task as { error?: { message?: string } }).error?.message).toBe("no intent matches the question");
  });

  it("onError receives the tool call's correlation id", async () => {
    const { onError } = await failedTaskFor(new LlmError("CONFIG", RAW_SDK_MESSAGE));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: expect.stringMatching(/^mcp:/) }),
    );
  });
});

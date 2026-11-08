import type { ComposeContext } from "@kohaku-ui/composer";
import { OUTCOME_UNKNOWN_MESSAGE } from "@kohaku-ui/host-core";
import type { AuthzPort, DomainPort, JsonObject } from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// A governed write whose answer never came back may or may not have been applied. The REST profile answers 503
// INTERNAL with host-core's fixed OUTCOME_UNKNOWN_MESSAGE; the MCP profile answers the same text as a structured
// tool error, and the real error (which names the upstream tool) still reaches onError.

const NO_COMPOSE = {} as unknown as ComposeContext;

const allowAuthz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "u1", roles: ["user"] } };
  },
};

function domainThrowing(error: Error): DomainPort {
  return {
    async listOperations() {
      return [{ name: "annotate", description: "d" }];
    },
    async invoke(_op: string, _args: JsonObject) {
      throw error;
    },
  };
}

async function connectClient(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-outcome-unknown-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "outcome-unknown-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content?: unknown }): string {
  return (result.content as { text: string }[])[0]!.text;
}

describe("MCP kohaku_action: a write with an unknown outcome", () => {
  it("answers the fixed OUTCOME_UNKNOWN_MESSAGE as a tool error and reports the real error", async () => {
    const timedOut = Object.assign(
      new Error('MCP tool "annotate": did not answer in time; its effect is unknown'),
      {
        code: "MCP_OUTCOME_UNKNOWN",
      },
    );
    const seen: { endpoint: string; error: unknown }[] = [];
    const client = await connectClient({
      compose: NO_COMPOSE,
      domain: domainThrowing(timedOut),
      authz: allowAuthz,
      querySource: "sales",
      onError: (info) => {
        seen.push(info);
      },
    });
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(OUTCOME_UNKNOWN_MESSAGE);
    expect(seen.some((c) => c.endpoint === "kohaku_action" && c.error === timedOut)).toBe(true);
    await client.close();
  });

  it("keeps the generic internal-error message for any other failed write", async () => {
    const client = await connectClient({
      compose: NO_COMPOSE,
      domain: domainThrowing(new Error("write failed (test)")),
      authz: allowAuthz,
      querySource: "sales",
    });
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("internal error; see the observability hook (onError) for details");
    await client.close();
  });
});

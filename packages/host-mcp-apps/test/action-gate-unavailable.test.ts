import type { ComposeContext } from "@kohaku-ui/composer";
import type { ActionAuditRecorder } from "@kohaku-ui/host-core";
import type {
  ApprovalPort,
  AuthzPort,
  DomainPort,
  JsonObject,
  OperationDescriptor,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// A gate that cannot decide (the operation index or the ApprovalPort throws) is a fail-closed denial that
// must be audited as `action.denied`, exactly as the REST profile's `gateUnavailable` does (SPEC ACT-APR-001,
// LIN-ACT-001). This mirrors host-rest's binding-action-gate.test.ts "gate infrastructure failures" block.

const NO_COMPOSE = {} as unknown as ComposeContext;

const allowAuthz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "u1", roles: ["user"] } };
  },
};

function recorderWith(denied: ReturnType<typeof vi.fn>): ActionAuditRecorder {
  return {
    invoked: async () => {},
    denied: denied as unknown as ActionAuditRecorder["denied"],
    approvalRequested: async () => {},
    approved: async () => {},
  };
}

function domainWith(invokeCalls: string[], ...ops: OperationDescriptor[]): DomainPort {
  return {
    async listOperations() {
      return ops;
    },
    async invoke(op: string, _args: JsonObject) {
      invokeCalls.push(op);
      return { ok: true };
    },
  };
}

async function connectClient(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-action-gate-unavailable-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "action-gate-unavailable-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content?: unknown }): string {
  return (result.content as { text: string }[])[0]!.text;
}

describe("MCP kohaku_action: gate infrastructure failures are audited denials (fail-closed)", () => {
  it("an ApprovalPort.verifyApproval that throws: isError, onError fires, action.denied is recorded with the descriptor tier, no invoke", async () => {
    const boom = new Error("approval store unavailable (test)");
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {});
    const onErrorCalls: { endpoint: string; error: unknown }[] = [];
    const approvals: ApprovalPort = {
      issueApproval: async () => "token",
      verifyApproval: async () => {
        throw boom;
      },
    };
    const client = await connectClient({
      compose: NO_COMPOSE,
      domain: domainWith(invokeCalls, { name: "delete", description: "d", tier: "approve" }),
      authz: allowAuthz,
      querySource: "sales",
      approvals,
      actionAuditRecorder: recorderWith(denied),
      onError: (info) => {
        onErrorCalls.push(info);
      },
    });

    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "delete", payload: {}, capability: "cap", approval: "tok" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("action gate unavailable");
    expect(textOf(result)).not.toContain("approval store");
    expect(invokeCalls).toEqual([]);
    expect(onErrorCalls.some((c) => c.endpoint === "kohaku_action" && c.error === boom)).toBe(true);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", tier: "approve", reason: "action gate unavailable" }),
    );
    await client.close();
  });

  it("a listOperations() that always rejects: isError, and action.denied is recorded with tier auto", async () => {
    const boom = new Error("domain permanently unavailable (test)");
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {});
    const domain: DomainPort = {
      async listOperations() {
        throw boom;
      },
      async invoke(op: string) {
        invokeCalls.push(op);
        return { ok: true };
      },
    };
    const client = await connectClient({
      compose: NO_COMPOSE,
      domain,
      authz: allowAuthz,
      querySource: "sales",
      actionAuditRecorder: recorderWith(denied),
    });

    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("operation index unavailable");
    expect(invokeCalls).toEqual([]);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ action: "annotate", tier: "auto", reason: "action gate unavailable" }),
    );
    await client.close();
  });
});

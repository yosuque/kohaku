import type { ComposeContext } from "@kohaku-ui/composer";
import type { ActionAuditRecorder } from "@kohaku-ui/host-core";
import { createOperationIndex } from "@kohaku-ui/host-core";
import type {
  AuthzPort,
  DomainPort,
  JsonObject,
  OperationDescriptor,
  TabularData,
  UISpec,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";
import { preresolveInitialData } from "../src/initial-data.js";
import type { ToolCallContext } from "../src/types.js";

// SPEC ACT-RD-001 (design.md #77) on the MCP profile: `${prefix}_resolve_binding` and the initial-data
// pre-resolution never execute an operation whose declared tier is "confirm" or "approve".

const NO_COMPOSE = {} as unknown as ComposeContext;
const DATA: TabularData = {
  columns: [{ key: "month", type: "string" }],
  rows: [{ month: "2026-04" }],
  dataVersion: "sales@seed-1",
};

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
      return DATA;
    },
  };
}

async function connect(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-gated-read-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, { rendererHtml: "<!DOCTYPE html><html><body>r</body></html>" });
  const client = new Client({ name: "gated-read-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content?: unknown }): string {
  return (result.content as { text: string }[])[0]!.text;
}

function depsWith(domain: DomainPort, extra?: Partial<McpHostDeps>): McpHostDeps {
  return { compose: NO_COMPOSE, domain, authz: allowAuthz, querySource: "sales", ...extra };
}

describe("MCP kohaku_resolve_binding: gated operations are not readable (ACT-RD-001)", () => {
  for (const tier of ["approve", "confirm"] as const) {
    it(`a ref naming a tier "${tier}" operation is a tool error and domain.invoke is not called`, async () => {
      const invokeCalls: string[] = [];
      const client = await connect(
        depsWith(domainWith(invokeCalls, { name: "purge", description: "d", tier })),
      );
      const result = await client.callTool({
        name: "kohaku_resolve_binding",
        arguments: { ref: "query://sales/purge?fy=2026", capability: "cap" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("capability denied: gated operation is not readable");
      expect(invokeCalls).toEqual([]);
      await client.close();
    });
  }

  it("records action.denied (fail-open) with the descriptor tier and the fixed reason", async () => {
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {});
    const client = await connect(
      depsWith(domainWith(invokeCalls, { name: "purge", description: "d", tier: "approve" }), {
        actionAuditRecorder: recorderWith(denied),
      }),
    );
    const result = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: "query://sales/purge", capability: "cap" },
    });
    expect(result.isError).toBe(true);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "purge",
        tier: "approve",
        reason: "gated operation is not readable",
        principal: { id: "u1", roles: ["user"] },
      }),
    );
    await client.close();
  });

  it('a tier-less operation and a tier "auto" operation stay readable', async () => {
    const invokeCalls: string[] = [];
    const client = await connect(
      depsWith(
        domainWith(
          invokeCalls,
          { name: "records", description: "d" },
          { name: "trend", description: "d", tier: "auto" },
        ),
      ),
    );
    for (const op of ["records", "trend"]) {
      const result = await client.callTool({
        name: "kohaku_resolve_binding",
        arguments: { ref: `query://sales/${op}`, capability: "cap" },
      });
      expect(result.isError).toBeFalsy();
    }
    expect(invokeCalls).toEqual(["records", "trend"]);
    await client.close();
  });

  it("an unreadable operation index fails closed: a tool error, audited as action.denied, no invoke", async () => {
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {});
    const domain: DomainPort = {
      async listOperations() {
        throw new Error("domain unavailable (test)");
      },
      async invoke(op: string) {
        invokeCalls.push(op);
        return DATA;
      },
    };
    const client = await connect(depsWith(domain, { actionAuditRecorder: recorderWith(denied) }));
    const result = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: "query://sales/records", capability: "cap" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("operation index unavailable");
    expect(invokeCalls).toEqual([]);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ action: "records", tier: "auto", reason: "action gate unavailable" }),
    );
    await client.close();
  });
});

describe("MCP initial-data pre-resolution: gated operations are not read ahead (ACT-RD-001)", () => {
  function specWith(...refs: string[]): UISpec {
    return {
      components: refs.map((ref, i) => ({ id: `c${i}`, type: "table", data: { $ref: ref } })),
    } as unknown as UISpec;
  }

  function ctxFor(domain: DomainPort, extra?: Partial<McpHostDeps>): ToolCallContext {
    return {
      deps: depsWith(domain, extra),
      operationIndex: createOperationIndex(domain),
      principal: { id: "tester", roles: ["user"] },
      requestId: "req-1",
    } as unknown as ToolCallContext;
  }

  it("skips a ref naming a gated operation (no invoke, nothing embedded), still embeds the readable ones, and audits the denial", async () => {
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {});
    const domain = domainWith(
      invokeCalls,
      { name: "purge", description: "d", tier: "approve" },
      { name: "confirmed", description: "d", tier: "confirm" },
      { name: "records", description: "d" },
    );
    const ctx = ctxFor(domain, { actionAuditRecorder: recorderWith(denied) });
    const { data, resolved } = await preresolveInitialData(
      specWith("query://sales/purge", "query://sales/confirmed", "query://sales/records"),
      ctx,
    );
    expect(invokeCalls).toEqual(["records"]);
    expect(Object.keys(data)).toEqual(["query://sales/records"]);
    expect([...resolved.keys()]).toEqual(["query://sales/records"]);
    expect(denied).toHaveBeenCalledTimes(2);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "purge",
        tier: "approve",
        reason: "gated operation is not readable",
      }),
    );
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirmed",
        tier: "confirm",
        reason: "gated operation is not readable",
      }),
    );
  });

  it("an unreadable operation index embeds nothing and invokes nothing (fail-closed), reporting to onError", async () => {
    const invokeCalls: string[] = [];
    const onError = vi.fn();
    const domain: DomainPort = {
      async listOperations() {
        throw new Error("domain unavailable (test)");
      },
      async invoke(op: string) {
        invokeCalls.push(op);
        return DATA;
      },
    };
    const ctx = ctxFor(domain, { onError });
    const { data } = await preresolveInitialData(specWith("query://sales/records"), ctx);
    expect(data).toEqual({});
    expect(invokeCalls).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "compose.initialData" }));
  });
});

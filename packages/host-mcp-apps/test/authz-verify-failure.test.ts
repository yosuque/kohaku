import type { ComposeContext } from "@kohaku-ui/composer";
import type { AuthzPort, DomainPort, JsonObject, TabularData } from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// A thrown authz.verify is an infrastructure failure (e.g. a revocation-store outage), not a normal denial
// -- see AuthzPort.verify's doc comment (spec-core's ports.ts): verify throws only on infrastructure
// failure, and a thrown verify is fail-closed. This mirrors host-rest's binding-resolve.test.ts /
// binding-action.test.ts equivalents: isError + a fixed client-safe message ("capability verification
// unavailable", the same text the REST surface uses for the same failure) + onError fires with the
// original error, and domain.invoke is never reached.

// kohaku_resolve_binding / kohaku_action don't reference compose, so a stub suffices (same as host-rest's
// NO_COMPOSE / principal.test.ts's fuller ComposeContext -- neither tool here ever reaches it).
const NO_COMPOSE = {} as unknown as ComposeContext;

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

const DATA: TabularData = {
  columns: [{ key: "month", type: "string" }],
  rows: [{ month: "2026-04" }],
  dataVersion: "sales@seed-1",
};

function throwingAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      throw new Error("revocation store unavailable (test)");
    },
  };
}

function recordingDomain(invokeCalls: string[]): DomainPort {
  return {
    async listOperations() {
      return [{ name: "annotate", description: "annotate (write)" }];
    },
    async invoke(op: string, _args: JsonObject) {
      invokeCalls.push(op);
      if (op === "trend") return DATA;
      return { ok: true };
    },
  };
}

async function connectClient(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-authz-verify-failure-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "authz-verify-failure-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP: a thrown authz.verify is fail-closed with a client-safe message", () => {
  it("kohaku_resolve_binding: isError with 'capability verification unavailable', onError fires, domain never reached", async () => {
    const invokeCalls: string[] = [];
    const onErrorCalls: { endpoint: string; error: unknown }[] = [];
    const client = await connectClient({
      compose: NO_COMPOSE,
      domain: recordingDomain(invokeCalls),
      authz: throwingAuthz(),
      querySource: "sales",
      onError: (info) => {
        onErrorCalls.push(info);
      },
    });

    const result = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: TREND_REF, capability: "cap" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { type: string; text: string }[])[0]!.text).toBe(
      "capability verification unavailable",
    );
    expect(invokeCalls).toEqual([]);
    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]!.endpoint).toBe("kohaku_resolve_binding");
    expect(onErrorCalls[0]!.error).toBeInstanceOf(Error);
  });

  it("kohaku_action: isError with 'capability verification unavailable', onError fires, domain never reached", async () => {
    const invokeCalls: string[] = [];
    const onErrorCalls: { endpoint: string; error: unknown }[] = [];
    const client = await connectClient({
      compose: NO_COMPOSE,
      domain: recordingDomain(invokeCalls),
      authz: throwingAuthz(),
      querySource: "sales",
      onError: (info) => {
        onErrorCalls.push(info);
      },
    });

    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "annotate", payload: {}, capability: "cap" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { type: string; text: string }[])[0]!.text).toBe(
      "capability verification unavailable",
    );
    expect(invokeCalls).toEqual([]);
    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]!.endpoint).toBe("kohaku_action");
    expect(onErrorCalls[0]!.error).toBeInstanceOf(Error);
  });
});

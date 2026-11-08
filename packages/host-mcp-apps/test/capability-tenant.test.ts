import type { ComposeContext } from "@kohaku-ui/composer";
import type { PolicyRateLimiter, PolicyRateLimiterTakeParams } from "@kohaku-ui/host-core";
import type {
  ApprovalPort,
  ApprovalVerifyResult,
  AuthzPort,
  DomainPort,
  InvocationContext,
  JsonObject,
  TabularData,
} from "@kohaku-ui/spec-core";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// SPEC CAP-TEN-002 on the MCP data plane: the profile resolves no tenant of its own, but it must not discard
// the tenant a verified capability binds (e.g. one minted by the REST host and replayed here). That tenant
// reaches DomainPort.invoke, the action gate's approval binding and the audit records; a tenant-less
// capability behaves exactly as before.

const NO_COMPOSE = {} as unknown as ComposeContext;
const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";
const DATA: TabularData = {
  columns: [{ key: "month", type: "string" }],
  rows: [{ month: "2026-04" }],
  dataVersion: "sales@seed-1",
};

function authzBinding(tenant: string | undefined): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true, principal: { id: "req" }, ...(tenant != null ? { tenant } : {}) };
    },
  };
}

function recordingDomain(contexts: InvocationContext[]): DomainPort {
  return {
    async listOperations() {
      return [{ name: "delete", description: "d", tier: "approve" }];
    },
    async invoke(op: string, _args: JsonObject, ctx: InvocationContext) {
      contexts.push(ctx);
      return op === "trend" ? DATA : { ok: true };
    },
  };
}

async function connect(deps: McpHostDeps): Promise<Client> {
  const server = new McpServer({ name: "kohaku-capability-tenant-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, { rendererHtml: "<!DOCTYPE html><html><body>r</body></html>" });
  const client = new Client({ name: "capability-tenant-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP: the verified capability's tenant is carried through (CAP-TEN-002)", () => {
  it("kohaku_resolve_binding: a REST-issued capability(tenant=A) reaches domain.invoke with tenant A", async () => {
    const contexts: InvocationContext[] = [];
    const client = await connect({
      compose: NO_COMPOSE,
      domain: recordingDomain(contexts),
      authz: authzBinding("A"),
      querySource: "sales",
    });
    const result = await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: TREND_REF, capability: "cap" },
    });
    expect(result.isError).toBeFalsy();
    expect(contexts[0]!.tenant).toBe("A");
  });

  it("kohaku_resolve_binding: a tenant-less capability leaves the invocation tenant unset (as before)", async () => {
    const contexts: InvocationContext[] = [];
    const client = await connect({
      compose: NO_COMPOSE,
      domain: recordingDomain(contexts),
      authz: authzBinding(undefined),
      querySource: "sales",
    });
    await client.callTool({
      name: "kohaku_resolve_binding",
      arguments: { ref: TREND_REF, capability: "cap" },
    });
    expect("tenant" in contexts[0]!).toBe(false);
  });

  it("kohaku_action: the capability's tenant scopes the approval binding, the audit record and domain.invoke", async () => {
    const contexts: InvocationContext[] = [];
    const verifyApproval = vi.fn(
      async (
        _token: string,
        req: { action: string; payloadHash: string; requesterId: string; tenant?: string },
      ): Promise<ApprovalVerifyResult> => ({
        ok: true,
        grant: {
          action: req.action,
          payloadHash: req.payloadHash,
          approverId: "approver",
          requesterId: req.requesterId,
          exp: 9999999999,
          jti: "j",
        },
      }),
    );
    const invoked = vi.fn(async (_args: { tenant?: string }) => {});
    const client = await connect({
      compose: NO_COMPOSE,
      domain: recordingDomain(contexts),
      authz: authzBinding("A"),
      querySource: "sales",
      approvals: { issueApproval: vi.fn(), verifyApproval } as unknown as ApprovalPort,
      actionAuditRecorder: {
        invoked,
        denied: async () => {},
        approvalRequested: async () => {},
        approved: async () => {},
      },
    });
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { action: "delete", payload: {}, capability: "cap", approval: "tok" },
    });
    expect(result.isError).toBeFalsy();
    expect(verifyApproval.mock.calls[0]![1].tenant).toBe("A");
    expect(invoked.mock.calls[0]![0].tenant).toBe("A");
    expect(contexts[0]!.tenant).toBe("A");
  });

  it("kohaku_action: a tenant-less capability sends no tenant to the gate or the domain", async () => {
    const contexts: InvocationContext[] = [];
    const verifyApproval = vi.fn(
      async (
        _token: string,
        req: { action: string; payloadHash: string; requesterId: string; tenant?: string },
      ): Promise<ApprovalVerifyResult> => ({
        ok: true,
        grant: {
          action: req.action,
          payloadHash: req.payloadHash,
          approverId: "approver",
          requesterId: req.requesterId,
          exp: 9999999999,
          jti: "j",
        },
      }),
    );
    const client = await connect({
      compose: NO_COMPOSE,
      domain: recordingDomain(contexts),
      authz: authzBinding(undefined),
      querySource: "sales",
      approvals: { issueApproval: vi.fn(), verifyApproval } as unknown as ApprovalPort,
    });
    await client.callTool({
      name: "kohaku_action",
      arguments: { action: "delete", payload: {}, capability: "cap", approval: "tok" },
    });
    expect(verifyApproval.mock.calls[0]![1].tenant).toBeUndefined();
    expect("tenant" in contexts[0]!).toBe(false);
  });

  // SPEC CAP-TEN-002: the data-plane rate limit is taken after the capability verified and keyed by its tenant,
  // so a tenant-scoped rule (policy `tenants.A.rateLimits`) is enforced over MCP too.
  describe("rate limit keyed by the capability's tenant", () => {
    /** Denies only tenant "A" (a tenant-only rule); records every take. */
    function tenantRuleLimiter(takes: PolicyRateLimiterTakeParams[]): PolicyRateLimiter {
      return {
        async take(params) {
          takes.push(params);
          return params.tenant === "A" ? { allow: false, retryAfterMs: 500 } : { allow: true };
        },
      };
    }

    it("kohaku_resolve_binding: the take carries the capability's tenant; a tenant-A rule denies and the domain is not invoked", async () => {
      const contexts: InvocationContext[] = [];
      const takes: PolicyRateLimiterTakeParams[] = [];
      const onRateLimited = vi.fn();
      const client = await connect({
        compose: NO_COMPOSE,
        domain: recordingDomain(contexts),
        authz: authzBinding("A"),
        querySource: "sales",
        rateLimiter: tenantRuleLimiter(takes),
        onRateLimited,
      });
      const result = await client.callTool({
        name: "kohaku_resolve_binding",
        arguments: { ref: TREND_REF, capability: "cap" },
      });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error?: { code?: string } }).error?.code).toBe("RATE_LIMITED");
      expect(takes).toHaveLength(1);
      expect(takes[0]).toMatchObject({ tenant: "A", routeClass: "resolve" });
      expect(contexts).toHaveLength(0);
      expect(onRateLimited).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: "A", routeClass: "resolve" }),
      );
    });

    it("kohaku_action: the take carries the capability's tenant; a tenant-A rule denies before the action runs", async () => {
      const contexts: InvocationContext[] = [];
      const takes: PolicyRateLimiterTakeParams[] = [];
      const onRateLimited = vi.fn();
      const client = await connect({
        compose: NO_COMPOSE,
        domain: recordingDomain(contexts),
        authz: authzBinding("A"),
        querySource: "sales",
        rateLimiter: tenantRuleLimiter(takes),
        onRateLimited,
      });
      const result = await client.callTool({
        name: "kohaku_action",
        arguments: { action: "delete", payload: {}, capability: "cap" },
      });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error?: { code?: string } }).error?.code).toBe("RATE_LIMITED");
      expect(takes[0]).toMatchObject({ tenant: "A", routeClass: "action" });
      expect(contexts).toHaveLength(0);
      expect(onRateLimited).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: "A", routeClass: "action" }),
      );
    });

    it("a tenant-less capability is taken without a tenant (the tenant-A rule does not apply)", async () => {
      const contexts: InvocationContext[] = [];
      const takes: PolicyRateLimiterTakeParams[] = [];
      const client = await connect({
        compose: NO_COMPOSE,
        domain: recordingDomain(contexts),
        authz: authzBinding(undefined),
        querySource: "sales",
        rateLimiter: tenantRuleLimiter(takes),
      });
      const result = await client.callTool({
        name: "kohaku_resolve_binding",
        arguments: { ref: TREND_REF, capability: "cap" },
      });
      expect(result.isError).toBeFalsy();
      expect("tenant" in takes[0]!).toBe(false);
    });

    it("a capability that fails verification is refused before the limiter is consulted", async () => {
      const takes: PolicyRateLimiterTakeParams[] = [];
      const client = await connect({
        compose: NO_COMPOSE,
        domain: recordingDomain([]),
        authz: {
          async issueCapability() {
            return "cap";
          },
          async verify() {
            return { ok: false, reason: "bad" };
          },
        },
        querySource: "sales",
        rateLimiter: tenantRuleLimiter(takes),
      });
      const result = await client.callTool({
        name: "kohaku_resolve_binding",
        arguments: { ref: TREND_REF, capability: "cap" },
      });
      expect(result.isError).toBe(true);
      expect(takes).toHaveLength(0);
    });
  });
});

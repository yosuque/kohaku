import type { ComposeContext } from "@kohaku-ui/composer";
import type { ActionAuditRecorder } from "@kohaku-ui/host-core";
import type { AuthzPort, DomainPort, JsonObject, OperationDescriptor } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// SPEC ACT-RD-001 (design.md #77): the data-plane read path (GET /binding/resolve) never executes an operation
// whose declared tier is "confirm" or "approve" -- those run only through the governed /binding/action gate.

const NO_COMPOSE = {} as unknown as ComposeContext;

const allowAuthz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "u1", roles: ["user"] } };
  },
};

function domainWith(invokeCalls: string[], ...ops: OperationDescriptor[]): DomainPort {
  return {
    async listOperations() {
      return ops;
    },
    async invoke(op: string, _args: JsonObject) {
      invokeCalls.push(op);
      return { columns: [], rows: [], dataVersion: "v1" };
    },
  };
}

function recorderWith(denied: ReturnType<typeof vi.fn>): ActionAuditRecorder {
  return {
    invoked: async () => {},
    denied: denied as unknown as ActionAuditRecorder["denied"],
    approvalRequested: async () => {},
    approved: async () => {},
  };
}

async function resolve(deps: KohakuHostDeps, ref: string) {
  const app = createKohakuRoutes(deps);
  return app.request(`/binding/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: "Bearer cap" },
  });
}

function depsWith(domain: DomainPort, extra?: Partial<KohakuHostDeps>): KohakuHostDeps {
  return { compose: NO_COMPOSE, domain, authz: allowAuthz, querySource: "sales", ...extra };
}

describe("GET /binding/resolve: gated operations are not readable (ACT-RD-001)", () => {
  for (const tier of ["approve", "confirm"] as const) {
    it(`a ref naming a tier "${tier}" operation is 403 CAPABILITY_DENIED and domain.invoke is not called`, async () => {
      const invokeCalls: string[] = [];
      const domain = domainWith(invokeCalls, { name: "purge", description: "d", tier });
      const res = await resolve(depsWith(domain), "query://sales/purge?fy=2026");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CAPABILITY_DENIED");
      expect(body.error.message).toBe("gated operation is not readable");
      expect(invokeCalls).toEqual([]);
    });
  }

  it("records action.denied (fail-open) with the descriptor tier and the fixed reason", async () => {
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {});
    const domain = domainWith(invokeCalls, { name: "purge", description: "d", tier: "approve" });
    const res = await resolve(
      depsWith(domain, { actionAuditRecorder: recorderWith(denied) }),
      "query://sales/purge?fy=2026",
    );
    expect(res.status).toBe(403);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "purge",
        tier: "approve",
        reason: "gated operation is not readable",
        principal: { id: "u1", roles: ["user"] },
      }),
    );
    expect(invokeCalls).toEqual([]);
  });

  it("a recorder that throws does not turn the denial into a failure (fail-open)", async () => {
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {
      throw new Error("audit store down (test)");
    });
    const domain = domainWith(invokeCalls, { name: "purge", description: "d", tier: "confirm" });
    const res = await resolve(
      depsWith(domain, { actionAuditRecorder: recorderWith(denied) }),
      "query://sales/purge",
    );
    expect(res.status).toBe(403);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(invokeCalls).toEqual([]);
  });

  it('a tier-less operation and a tier "auto" operation stay readable', async () => {
    const invokeCalls: string[] = [];
    const domain = domainWith(
      invokeCalls,
      { name: "records", description: "d" },
      { name: "trend", description: "d", tier: "auto" },
    );
    const deps = depsWith(domain);
    expect((await resolve(deps, "query://sales/records?fy=2026")).status).toBe(200);
    expect((await resolve(deps, "query://sales/trend")).status).toBe(200);
    expect(invokeCalls).toEqual(["records", "trend"]);
  });

  it("a ref whose operation is not in the index stays readable (as before)", async () => {
    const invokeCalls: string[] = [];
    const res = await resolve(depsWith(domainWith(invokeCalls)), "query://sales/records");
    expect(res.status).toBe(200);
    expect(invokeCalls).toEqual(["records"]);
  });

  it("an operation whose paramsSchema is invalid is still gated by its tier", async () => {
    const invokeCalls: string[] = [];
    const domain = domainWith(invokeCalls, {
      name: "purge",
      description: "d",
      tier: "approve",
      paramsSchema: { type: "object", $ref: "#/nope" },
    });
    const res = await resolve(depsWith(domain), "query://sales/purge");
    expect(res.status).toBe(403);
    expect(invokeCalls).toEqual([]);
  });

  it("an unreadable operation index fails closed: 503 INTERNAL, audited as action.denied, no invoke", async () => {
    const invokeCalls: string[] = [];
    const denied = vi.fn(async () => {});
    const onError = vi.fn();
    const domain: DomainPort = {
      async listOperations() {
        throw new Error("domain unavailable (test)");
      },
      async invoke(op: string) {
        invokeCalls.push(op);
        return { columns: [], rows: [] };
      },
    };
    const res = await resolve(
      depsWith(domain, { actionAuditRecorder: recorderWith(denied), onError }),
      "query://sales/records",
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("action gate unavailable");
    expect(invokeCalls).toEqual([]);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ action: "records", tier: "auto", reason: "action gate unavailable" }),
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "binding/resolve" }));
  });

  it("a tier-less operation with an invalid paramsSchema is refused too: 500 INTERNAL, reported, no invoke (as the action path)", async () => {
    const invokeCalls: string[] = [];
    const onError = vi.fn();
    const domain = domainWith(invokeCalls, {
      name: "odd",
      description: "d",
      paramsSchema: { type: "object", $ref: "#/nope" },
    });
    const res = await resolve(depsWith(domain, { onError }), "query://sales/odd");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("action is not available on this host");
    expect(invokeCalls).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "binding/resolve" }));
  });
});

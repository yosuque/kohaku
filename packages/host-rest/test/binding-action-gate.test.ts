import type { ComposeContext } from "@kohaku-ui/composer";
import type { ActionAuditRecorder } from "@kohaku-ui/host-core";
import type {
  ApprovalPort,
  ApprovalVerifyResult,
  AuthzPort,
  DomainPort,
  JsonObject,
  OperationDescriptor,
} from "@kohaku-ui/spec-core";
import { actionPayloadHash } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

const NO_COMPOSE = {} as unknown as ComposeContext;

function allowAuthz(): AuthzPort {
  return {
    async issueCapability() {
      return "cap";
    },
    async verify() {
      return { ok: true, principal: { id: "u1", roles: ["user"] } };
    },
  };
}

function domainWith(...ops: OperationDescriptor[]): DomainPort {
  const invokeCalls: { op: string; args: JsonObject }[] = [];
  const domain: DomainPort & { invokeCalls: typeof invokeCalls } = {
    invokeCalls,
    async listOperations() {
      return ops;
    },
    async invoke(op: string, args: JsonObject) {
      invokeCalls.push({ op, args });
      return { ok: true, op, args };
    },
  };
  return domain;
}

function baseDeps(extra?: Partial<KohakuHostDeps>): KohakuHostDeps {
  return {
    compose: NO_COMPOSE,
    domain: domainWith(),
    authz: allowAuthz(),
    querySource: "sales",
    ...extra,
  };
}

async function postAction(deps: KohakuHostDeps, body: unknown) {
  const app = createKohakuRoutes(deps);
  return app.request("/binding/action", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cap" },
    body: JSON.stringify(body),
  });
}

const NOTE_SCHEMA = {
  type: "object",
  properties: { note: { type: "string", maxLength: 5 } },
  required: ["note"],
};

describe("POST /binding/action: tier auto (default, and explicit)", () => {
  it("an action absent from listOperations() is invoked ungated (backward compatible)", async () => {
    const deps = baseDeps();
    const res = await postAction(deps, { action: "annotate", payload: { note: "hi" } });
    expect(res.status).toBe(200);
  });

  it("an action present with tier auto (or omitted) is invoked once params validate", async () => {
    const domain = domainWith({ name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA });
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "annotate", payload: { note: "hi" } });
    expect(res.status).toBe(200);
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(1);
  });
});

describe("POST /binding/action: params validation (ACT-PRM-001)", () => {
  it("rejects invalid params with 422 ACTION_PARAMS_INVALID and the exact issues, without invoking the domain", async () => {
    const domain = domainWith({ name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA });
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "annotate", payload: { note: "way too long" } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; issues: unknown } };
    expect(body.error.code).toBe("ACTION_PARAMS_INVALID");
    expect(body.error.issues).toEqual([
      { path: "note", code: "maxLength", message: "expected at most 5 characters" },
    ]);
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });
});

describe("POST /binding/action: tier confirm (ACT-APR-001/ACT-CNF-001)", () => {
  it("without confirmed: true, returns 403 APPROVAL_REQUIRED and never invokes the domain", async () => {
    const domain = domainWith({ name: "annotate", description: "d", tier: "confirm" });
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "annotate", payload: {} });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; approval: Record<string, unknown> } };
    expect(body.error.code).toBe("APPROVAL_REQUIRED");
    expect(body.error.approval).toMatchObject({ action: "annotate", tier: "confirm" });
    expect(typeof body.error.approval["requestId"]).toBe("string");
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });

  it("with confirmed: true, invokes the domain", async () => {
    const domain = domainWith({ name: "annotate", description: "d", tier: "confirm" });
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "annotate", payload: {}, confirmed: true });
    expect(res.status).toBe(200);
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(1);
  });

  it("records action.approvalRequested (fail-open) when pending, and action.invoked once confirmed", async () => {
    const domain = domainWith({ name: "annotate", description: "d", tier: "confirm" });
    const approvalRequested = vi.fn(
      async (_args: Parameters<ActionAuditRecorder["approvalRequested"]>[0]) => {},
    );
    const invoked = vi.fn(async (_args: Parameters<ActionAuditRecorder["invoked"]>[0]) => {});
    const deps = baseDeps({
      domain,
      actionAuditRecorder: {
        invoked,
        denied: vi.fn(async () => {}),
        approvalRequested,
        approved: vi.fn(async () => {}),
      },
    });

    await postAction(deps, { action: "annotate", payload: {} });
    expect(approvalRequested).toHaveBeenCalledTimes(1);
    expect(approvalRequested.mock.calls[0]![0]).toMatchObject({ action: "annotate", tier: "confirm" });

    await postAction(deps, { action: "annotate", payload: {}, confirmed: true });
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(invoked.mock.calls[0]![0]).toMatchObject({ action: "annotate", tier: "confirm" });
  });

  it("a throwing actionAuditRecorder does not break the response (fail-open)", async () => {
    const domain = domainWith({ name: "annotate", description: "d", tier: "confirm" });
    const seen: { endpoint: string }[] = [];
    const deps = baseDeps({
      domain,
      actionAuditRecorder: {
        invoked: async () => {},
        denied: async () => {},
        approvalRequested: async () => {
          throw new Error("recorder unavailable (test)");
        },
        approved: async () => {},
      },
      onError: (info) => {
        seen.push({ endpoint: info.endpoint });
      },
    });
    const res = await postAction(deps, { action: "annotate", payload: {} });
    expect(res.status).toBe(403);
    expect(seen).toEqual([{ endpoint: "binding/action.audit" }]);
  });
});

describe("POST /binding/action: tier approve (ACT-APR-001)", () => {
  function fakeApprovals(verify: ApprovalPort["verifyApproval"]): ApprovalPort {
    return {
      async issueApproval() {
        throw new Error("not used in these tests");
      },
      verifyApproval: verify,
    };
  }

  it("without an approval token, returns 403 APPROVAL_REQUIRED", async () => {
    const domain = domainWith({ name: "delete", description: "d", tier: "approve" });
    const deps = baseDeps({ domain, approvals: fakeApprovals(async () => ({ ok: true })) });
    const res = await postAction(deps, { action: "delete", payload: {} });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { approval: Record<string, unknown> } };
    expect(body.error.approval).toMatchObject({ action: "delete", tier: "approve" });
  });

  it("without an ApprovalPort configured at all, returns 403 (denied, permanent)", async () => {
    const domain = domainWith({ name: "delete", description: "d", tier: "approve" });
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "delete", payload: {}, approval: "some-token" });
    expect(res.status).toBe(403);
  });

  it("with a valid approval token, invokes the domain and passes the correct binding to verifyApproval", async () => {
    const domain = domainWith({ name: "delete", description: "d", tier: "approve" });
    const verify = vi.fn(
      async (
        _token: string,
        _req: { action: string; payloadHash: string; requesterId: string; tenant?: string },
      ): Promise<ApprovalVerifyResult> => ({
        ok: true,
        grant: {
          action: "delete",
          payloadHash: _req.payloadHash,
          approverId: "approver-1",
          requesterId: "u1",
          exp: 9999999999,
          jti: "jti-1",
        },
      }),
    );
    const approved = vi.fn(async (_args: Parameters<ActionAuditRecorder["approved"]>[0]) => {});
    const deps = baseDeps({
      domain,
      approvals: fakeApprovals(verify),
      actionAuditRecorder: {
        invoked: async () => {},
        denied: async () => {},
        approvalRequested: async () => {},
        approved,
      },
    });
    const res = await postAction(deps, { action: "delete", payload: { id: 1 }, approval: "token-abc" });
    expect(res.status).toBe(200);
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(1);

    expect(verify).toHaveBeenCalledTimes(1);
    const [token, req] = verify.mock.calls[0]!;
    expect(token).toBe("token-abc");
    expect(req.action).toBe("delete");
    expect(req.requesterId).toBe("u1");
    expect(req.payloadHash).toBe(await actionPayloadHash({ id: 1 }));

    expect(approved).toHaveBeenCalledTimes(1);
    expect(approved.mock.calls[0]![0]).toMatchObject({
      action: "delete",
      grant: { approverId: "approver-1" },
    });
  });

  it("with an invalid approval token, returns 403 and records action.denied (not approvalRequested)", async () => {
    const domain = domainWith({ name: "delete", description: "d", tier: "approve" });
    const denied = vi.fn(async (_args: Parameters<ActionAuditRecorder["denied"]>[0]) => {});
    const approvalRequested = vi.fn(
      async (_args: Parameters<ActionAuditRecorder["approvalRequested"]>[0]) => {},
    );
    const deps = baseDeps({
      domain,
      approvals: fakeApprovals(async () => ({ ok: false, reason: "approval already used" })),
      actionAuditRecorder: {
        invoked: async () => {},
        denied,
        approvalRequested,
        approved: async () => {},
      },
    });
    const res = await postAction(deps, { action: "delete", payload: {}, approval: "token-abc" });
    expect(res.status).toBe(403);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0]![0]).toMatchObject({ action: "delete", reason: "approval already used" });
    expect(approvalRequested).not.toHaveBeenCalled();
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });
});

import type { ComposeContext } from "@kohaku-ui/composer";
import { ApprovalIssueError, type ApprovalPort, type AuthzPort, type DomainPort } from "@kohaku-ui/spec-core";
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

function noOpDomain(): DomainPort {
  return {
    async listOperations() {
      return [];
    },
    async invoke() {
      return null;
    },
  };
}

function baseDeps(extra?: Partial<KohakuHostDeps>): KohakuHostDeps {
  return {
    compose: NO_COMPOSE,
    domain: noOpDomain(),
    authz: allowAuthz(),
    querySource: "sales",
    ...extra,
  };
}

async function postApprovals(deps: KohakuHostDeps, body: unknown) {
  const app = createKohakuRoutes(deps);
  return app.request("/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { action: "delete", payloadHash: "sha256:" + "a".repeat(64), requesterId: "requester-1" };

describe("POST /approvals", () => {
  it("returns 501 NOT_IMPLEMENTED when deps.approvals is not configured", async () => {
    const res = await postApprovals(baseDeps(), VALID_BODY);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_IMPLEMENTED");
  });

  it("issues a token when authorized and approver != requester", async () => {
    const issueApproval = vi.fn(
      async (
        _input: {
          action: string;
          payloadHash: string;
          requesterId: string;
          approverId: string;
          tenant?: string;
        },
        _opts?: { ttlSeconds?: number },
      ) => "kohaku-approval.v1.token",
    );
    const approvals: ApprovalPort = { issueApproval, verifyApproval: async () => ({ ok: true }) };
    const deps = baseDeps({ approvals, auth: async () => ({ id: "approver-1", roles: ["approver"] }) });

    const res = await postApprovals(deps, VALID_BODY);
    expect(res.status).toBe(200);
    expect((await res.json()) as { approval: string }).toEqual({ approval: "kohaku-approval.v1.token" });

    expect(issueApproval).toHaveBeenCalledTimes(1);
    const [input] = issueApproval.mock.calls[0]!;
    expect(input).toMatchObject({
      action: "delete",
      payloadHash: VALID_BODY.payloadHash,
      requesterId: "requester-1",
      approverId: "approver-1",
    });
  });

  it("rejects a self-approval (approver == requester) with 400, without calling issueApproval", async () => {
    const issueApproval = vi.fn(async () => "should-not-be-issued");
    const approvals: ApprovalPort = { issueApproval, verifyApproval: async () => ({ ok: true }) };
    const deps = baseDeps({
      approvals,
      auth: async () => ({ id: "requester-1", roles: ["approver"] }),
    });

    const res = await postApprovals(deps, VALID_BODY);
    expect(res.status).toBe(400);
    expect(issueApproval).not.toHaveBeenCalled();
  });

  it("returns 403 CAPABILITY_DENIED when authorizeGovernance denies action.approve", async () => {
    const approvals: ApprovalPort = {
      issueApproval: async () => "token",
      verifyApproval: async () => ({ ok: true }),
    };
    const deps = baseDeps({
      approvals,
      authorizeGovernance: async (_principal, operation) => operation.kind !== "action.approve",
    });

    const res = await postApprovals(deps, VALID_BODY);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CAPABILITY_DENIED");
  });

  it("rejects a missing required field with 400 BAD_REQUEST", async () => {
    const approvals: ApprovalPort = {
      issueApproval: async () => "token",
      verifyApproval: async () => ({ ok: true }),
    };
    const res = await postApprovals(baseDeps({ approvals }), { action: "delete" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("an ApprovalIssueError from issueApproval (e.g. the port's own self-approval guard) maps to 400 with its message", async () => {
    const approvals: ApprovalPort = {
      issueApproval: async () => {
        throw new ApprovalIssueError("cannot issue an approval: approverId must differ from requesterId");
      },
      verifyApproval: async () => ({ ok: true }),
    };
    const deps = baseDeps({ approvals, auth: async () => ({ id: "approver-1", roles: ["approver"] }) });
    const res = await postApprovals(deps, VALID_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("approverId must differ from requesterId");
  });

  it("an Error carrying the client-caused code (a port that does not import the class) also maps to 400", async () => {
    const approvals: ApprovalPort = {
      issueApproval: async () => {
        throw Object.assign(new Error("payload hash is not acceptable"), { code: "APPROVAL_ISSUE_REJECTED" });
      },
      verifyApproval: async () => ({ ok: true }),
    };
    const deps = baseDeps({ approvals, auth: async () => ({ id: "approver-1", roles: ["approver"] }) });
    const res = await postApprovals(deps, VALID_BODY);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "payload hash is not acceptable",
    );
  });

  it("any other thrown issueApproval is a fixed-text 500 INTERNAL that never leaks the raw message, and reaches onError", async () => {
    const boom = Object.assign(new Error("connection to db-primary.internal:5432 refused"), {
      code: "ECONNREFUSED",
    });
    const approvals: ApprovalPort = {
      issueApproval: async () => {
        throw boom;
      },
      verifyApproval: async () => ({ ok: true }),
    };
    const onError = vi.fn();
    const deps = baseDeps({
      approvals,
      onError,
      auth: async () => ({ id: "approver-1", roles: ["approver"] }),
    });
    const res = await postApprovals(deps, VALID_BODY);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string; requestId?: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("db-primary");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ endpoint: "approvals", error: boom });
    expect(onError.mock.calls[0]![0].requestId).toBe(body.error.requestId);
  });

  it("passes ttlSeconds through when given", async () => {
    const issueApproval = vi.fn(
      async (
        _input: {
          action: string;
          payloadHash: string;
          requesterId: string;
          approverId: string;
          tenant?: string;
        },
        _opts?: { ttlSeconds?: number },
      ) => "token",
    );
    const approvals: ApprovalPort = { issueApproval, verifyApproval: async () => ({ ok: true }) };
    const deps = baseDeps({ approvals, auth: async () => ({ id: "approver-1", roles: ["approver"] }) });

    await postApprovals(deps, { ...VALID_BODY, ttlSeconds: 60 });
    expect(issueApproval.mock.calls[0]![1]).toEqual({ ttlSeconds: 60 });
  });
});

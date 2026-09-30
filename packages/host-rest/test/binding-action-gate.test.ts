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
  it("an action absent from listOperations() is rejected with 403 CAPABILITY_DENIED, without invoking the domain (fail-closed)", async () => {
    const domain = domainWith();
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "annotate", payload: { note: "hi" } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CAPABILITY_DENIED");
    expect(body.error.message).toBe("action is not a declared DomainPort operation");
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });

  it("records action.denied (fail-open) for an action absent from listOperations()", async () => {
    const domain = domainWith();
    const denied = vi.fn(async (_args: Parameters<ActionAuditRecorder["denied"]>[0]) => {});
    const deps = baseDeps({
      domain,
      actionAuditRecorder: {
        invoked: async () => {},
        denied,
        approvalRequested: async () => {},
        approved: async () => {},
      },
    });
    await postAction(deps, { action: "annotate", payload: { note: "hi" } });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0]![0]).toMatchObject({
      action: "annotate",
      tier: "auto",
      reason: "action is not a declared DomainPort operation",
    });
  });

  it("rejects the A2UI inbound forwarding sentinel the same way -- it must never be a real registered operation (design.md decision 60)", async () => {
    // "a2ui.forward" is host-a2ui's A2UI_FORWARD_ACTION (packages/host-a2ui/src/inbound/from-a2ui.ts):
    // decision #60 requires it is never registered as a real DomainPort operation, so it must always fall
    // into this same undeclared-action path regardless of which DomainPort a host wires.
    const domain = domainWith();
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "a2ui.forward", payload: {} });
    expect(res.status).toBe(403);
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
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

  it("rejects a constructor key in the payload with 422 ACTION_PARAMS_INVALID, without invoking the domain", async () => {
    // Regression test for a prototype-chain lookup bug in validateActionParams (spec-core). "constructor"
    // reaches the gate as a genuine own property of the parsed payload; an own "__proto__" key is stripped by
    // the body's JsonObjectSchema (zod's z.record) and is covered by the raw-body scan tested below.
    const domain = domainWith({ name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA });
    const deps = baseDeps({ domain });
    const app = createKohakuRoutes(deps);
    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cap" },
      body: '{"action":"annotate","payload":{"note":"hi","constructor":{"polluted":true}}}',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; issues: unknown } };
    expect(body.error.code).toBe("ACTION_PARAMS_INVALID");
    expect(body.error.issues).toEqual([
      { path: "constructor", code: "unsafeKey", message: 'the property name "constructor" is not allowed' },
    ]);
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });
});

describe("POST /binding/action: __proto__ payload key (ACT-PRM-001)", () => {
  it("rejects an own __proto__ key that zod would silently strip, with the same 422 unsafeKey issue", async () => {
    const domain = domainWith({ name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA });
    const app = createKohakuRoutes(baseDeps({ domain }));
    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cap" },
      body: '{"action":"annotate","payload":{"note":"hi","nested":{"__proto__":{"polluted":true}}}}',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; issues: unknown } };
    expect(body.error.code).toBe("ACTION_PARAMS_INVALID");
    expect(body.error.issues).toEqual([
      {
        path: "nested.__proto__",
        code: "unsafeKey",
        message: 'the property name "__proto__" is not allowed',
      },
    ]);
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });
});

describe("POST /binding/action: gate infrastructure failures (fail-closed, SPEC ACT-APR-001)", () => {
  type ErrorBody = { error: { code: string; message: string; requestId?: string } };

  function recorderWith(denied: ReturnType<typeof vi.fn>): ActionAuditRecorder {
    return {
      invoked: async () => {},
      denied: denied as unknown as ActionAuditRecorder["denied"],
      approvalRequested: async () => {},
      approved: async () => {},
    };
  }

  it("a listOperations() rejection answers 503 INTERNAL with the envelope, reports to onError and records action.denied", async () => {
    const boom = new Error("db-primary.internal refused");
    const domain: DomainPort = {
      async listOperations() {
        throw boom;
      },
      async invoke() {
        throw new Error("must not be invoked");
      },
    };
    const denied = vi.fn(async () => {});
    const onError = vi.fn();
    const deps = baseDeps({ domain, onError, actionAuditRecorder: recorderWith(denied) });
    const res = await postAction(deps, { action: "annotate", payload: {} });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("action gate unavailable");
    expect(body.error.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "binding/action", error: boom }),
    );
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ action: "annotate", tier: "auto", reason: "action gate unavailable" }),
    );
  });

  it("an ApprovalPort.verifyApproval that throws is a denial (503, no invoke), audited with the descriptor tier", async () => {
    const boom = new Error("approval store unavailable");
    const domain = domainWith({ name: "delete", description: "d", tier: "approve" });
    const approvals: ApprovalPort = {
      issueApproval: async () => "token",
      verifyApproval: async () => {
        throw boom;
      },
    };
    const denied = vi.fn(async () => {});
    const onError = vi.fn();
    const deps = baseDeps({ domain, approvals, onError, actionAuditRecorder: recorderWith(denied) });
    const res = await postAction(deps, { action: "delete", payload: {}, approval: "tok" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("approval store");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "binding/action", error: boom }),
    );
    expect(denied).toHaveBeenCalledWith(expect.objectContaining({ action: "delete", tier: "approve" }));
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });

  it("an error nothing handled still answers the SPEC envelope (not text/plain) and reaches onError", async () => {
    const boom = new Error("recorder exploded");
    const onError = vi.fn();
    const deps = baseDeps({
      onError,
      // A throwing tenant hook is outside every route's own try/catch.
      tenant: async () => {
        throw boom;
      },
    });
    const app = createKohakuRoutes(deps);
    const res = await app.request("/catalog");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("exploded");
    expect(body.error.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "unhandled", error: boom }));
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

  it("without an ApprovalPort configured and no token presented either, still 403 denied with a clear reason (not 'requires an approval token')", async () => {
    const domain = domainWith({ name: "delete", description: "d", tier: "approve" });
    const deps = baseDeps({ domain });
    const res = await postAction(deps, { action: "delete", payload: {} });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("APPROVAL_REQUIRED");
    expect(body.error.message).toBe("no ApprovalPort is configured for this host");
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
    // The port's own reason is audited but never shown to the client (it would reveal which binding mismatched).
    const denial = (await res.json()) as { error: { message: string } };
    expect(denial.error.message).toBe("approval token was rejected");
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0]![0]).toMatchObject({ action: "delete", reason: "approval already used" });
    expect(approvalRequested).not.toHaveBeenCalled();
    expect((domain as unknown as { invokeCalls: unknown[] }).invokeCalls).toHaveLength(0);
  });
});

describe("createKohakuRoutes: paramsSchema validation at attach", () => {
  it("reports a paramsSchema outside the closed subset through onError right away, without throwing", async () => {
    const seen: { endpoint: string; error: unknown }[] = [];
    const deps = baseDeps({
      domain: domainWith({
        name: "annotate",
        description: "d",
        paramsSchema: { type: "string", pattern: "^[a-z]+$" } as never,
      }),
      onError: (info) => {
        seen.push({ endpoint: info.endpoint, error: info.error });
      },
    });
    createKohakuRoutes(deps);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.endpoint).toBe("attach.operationIndex");
    expect((seen[0]!.error as Error).message).toContain('operation "annotate" has an invalid paramsSchema');
  });

  it("a bad paramsSchema breaks only that operation: it fails closed (500 envelope) and the other operation still invokes", async () => {
    const domain = domainWith(
      { name: "annotate", description: "d", paramsSchema: { type: "string", pattern: "^a$" } as never },
      { name: "publish", description: "d" },
    );
    const deps = baseDeps({ domain, onError: () => {} });
    const broken = await postAction(deps, { action: "annotate", payload: {} });
    expect(broken.status).toBe(500);
    expect(((await broken.json()) as { error: { code: string } }).error.code).toBe("INTERNAL");
    const ok = await postAction(deps, { action: "publish", payload: {} });
    expect(ok.status).toBe(200);
    expect((domain as unknown as { invokeCalls: { op: string }[] }).invokeCalls.map((c) => c.op)).toEqual([
      "publish",
    ]);
  });

  it("reports nothing for a valid domain", async () => {
    const seen: string[] = [];
    const deps = baseDeps({
      domain: domainWith({ name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA as never }),
      onError: (info) => {
        seen.push(info.endpoint);
      },
    });
    createKohakuRoutes(deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
  });

  it("a listOperations() rejection at attach is reported, and a later request retries it", async () => {
    let calls = 0;
    const domain: DomainPort = {
      async listOperations() {
        calls += 1;
        if (calls === 1) throw new Error("listOperations unavailable (transient)");
        return [{ name: "annotate", description: "d" }];
      },
      async invoke() {
        return { ok: true };
      },
    };
    const seen: string[] = [];
    const deps = baseDeps({
      domain,
      onError: (info) => {
        seen.push(info.endpoint);
      },
    });
    const app = createKohakuRoutes(deps);
    await vi.waitFor(() => expect(seen).toContain("attach.operationIndex"));
    // The failed index was not memoized: the request's own read retries and succeeds.
    const res = await app.request("/binding/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cap" },
      body: JSON.stringify({ action: "annotate", payload: {} }),
    });
    expect(res.status).toBe(200);
  });
});

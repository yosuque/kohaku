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
import { describe, expect, it, vi } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// Characterization of the governed-action gate sequence of POST /binding/action as the REST profile runs it
// today, pinned BEFORE the sequence is extracted into host-core: for every outcome, the ordered log of
// observability-hook calls (endpoint, correlation id, error), audit-recorder records (type, action, tier,
// reason, correlation id, tenant, principal), the domain.invoke call, and the wire result.
// These tests describe what the code does, not what it should do.

const NO_COMPOSE = {} as unknown as ComposeContext;
const RID = "<requestId>";

type LogEntry = Record<string, unknown>;

const allowAuthz: AuthzPort = {
  async issueCapability() {
    return "cap";
  },
  async verify() {
    return { ok: true, principal: { id: "u1", roles: ["user"] } };
  },
};

const NOTE_SCHEMA = {
  type: "object",
  properties: { note: { type: "string", maxLength: 5 } },
  required: ["note"],
};

interface RigOptions {
  /** The operations `listOperations` returns (ignored when `listOperationsError` is set). */
  ops?: OperationDescriptor[];
  listOperationsError?: Error;
  approvals?: ApprovalPort;
  /** Makes the named recorder method reject (fail-open: must not change the wire result). */
  failingRecorder?: "invoked" | "denied" | "approvalRequested" | "approved";
  /** Sent as `x-kohaku-tenant` (resolved by `deps.tenant`); omitted = no tenant on the request. */
  tenant?: string;
}

/** One rig: a host over a recording domain / hook / audit recorder, plus the request helper. */
function rig(options: RigOptions) {
  const log: LogEntry[] = [];
  const domain: DomainPort = {
    async listOperations() {
      if (options.listOperationsError != null) throw options.listOperationsError;
      return options.ops ?? [];
    },
    async invoke(op: string, args: JsonObject) {
      log.push({ invoke: op, args });
      return { ok: true, op, args };
    },
  };
  const record = (type: string) => async (args: Record<string, unknown>) => {
    log.push({
      audit: type,
      action: args["action"],
      ...("tier" in args ? { tier: args["tier"] } : {}),
      ...("reason" in args ? { reason: args["reason"] } : {}),
      ...("grant" in args ? { grant: (args["grant"] as { approverId: string }).approverId } : {}),
      correlationId: args["correlationId"],
      tenant: "tenant" in args ? args["tenant"] : "(absent)",
      principal: (args["principal"] as { id: string }).id,
    });
    if (options.failingRecorder === type) throw new Error(`recorder ${type} down`);
  };
  const deps: KohakuHostDeps = {
    compose: NO_COMPOSE,
    domain,
    authz: allowAuthz,
    querySource: "sales",
    tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
    ...(options.approvals != null ? { approvals: options.approvals } : {}),
    onError: (info) => {
      log.push({
        report: info.endpoint,
        requestId: info.requestId,
        error: (info.error as Error).message,
      });
    },
    actionAuditRecorder: {
      invoked: record("invoked"),
      denied: record("denied"),
      approvalRequested: record("approvalRequested"),
      approved: record("approved"),
    } as unknown as ActionAuditRecorder,
  };
  const app = createKohakuRoutes(deps);

  async function post(rawBody: string) {
    // Let the attach-time operation-index validation (background, microtask-only) settle first, and take the
    // log baseline after it, so only the request's own sequence is asserted.
    await vi.waitFor(() => {
      if (options.listOperationsError != null || (options.ops ?? []).some((o) => o.name === "broken")) {
        expect(log.some((e) => e["report"] === "attach.operationIndex")).toBe(true);
      }
    });
    await new Promise((r) => setTimeout(r, 0));
    const baseline = log.length;
    const res = await app.request("/binding/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer cap",
        ...(options.tenant != null ? { "x-kohaku-tenant": options.tenant } : {}),
      },
      body: rawBody,
    });
    const rid = res.headers.get("X-Request-Id");
    expect(rid).toBeTruthy();
    const sequence = log.slice(baseline).map((e) => {
      const out: LogEntry = {};
      for (const [k, v] of Object.entries(e)) out[k] = v === rid ? RID : v;
      return out;
    });
    const body = (await res.json()) as {
      error?: { code: string; message: string; requestId?: string; issues?: unknown; approval?: unknown };
    };
    if (body.error?.requestId != null) expect(body.error.requestId).toBe(rid);
    return { status: res.status, body, sequence };
  }
  return { post };
}

function actionBody(action: string, payload: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({ action, payload, ...extra });
}

function fakeApprovals(verify: ApprovalPort["verifyApproval"]): ApprovalPort {
  return {
    async issueApproval() {
      throw new Error("not used in these tests");
    },
    verifyApproval: verify,
  };
}

describe("POST /binding/action: gate sequence, one test per outcome", () => {
  it("index throws: report(binding/action) then action.denied tier auto, 503 INTERNAL, no invoke", async () => {
    const h = rig({ listOperationsError: new Error("index down"), tenant: "acme" });
    const r = await h.post(actionBody("annotate", {}));
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual({
      code: "INTERNAL",
      message: "action gate unavailable",
      requestId: expect.any(String),
    });
    expect(r.sequence).toEqual([
      { report: "binding/action", requestId: RID, error: "index down" },
      {
        audit: "denied",
        action: "annotate",
        tier: "auto",
        reason: "action gate unavailable",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
    ]);
  });

  it("undeclared action: action.denied tier auto only (no report), 403 CAPABILITY_DENIED, no invoke", async () => {
    const h = rig({ ops: [], tenant: "acme" });
    const r = await h.post(actionBody("annotate", { note: "hi" }));
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual({
      code: "CAPABILITY_DENIED",
      message: "action is not a declared DomainPort operation",
    });
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "annotate",
        tier: "auto",
        reason: "action is not a declared DomainPort operation",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
    ]);
  });

  it("undeclared action with a failing recorder: the audit failure is reported with the request id, wire unchanged", async () => {
    const h = rig({ ops: [], failingRecorder: "denied" });
    const r = await h.post(actionBody("annotate", {}));
    expect(r.status).toBe(403);
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "annotate",
        tier: "auto",
        reason: "action is not a declared DomainPort operation",
        correlationId: RID,
        tenant: "(absent)",
        principal: "u1",
      },
      { report: "binding/action.audit", requestId: RID, error: "recorder denied down" },
    ]);
  });

  it("schemaError entry: report(binding/action) only (no audit record), 500 INTERNAL, no invoke", async () => {
    const h = rig({
      ops: [{ name: "broken", description: "d", paramsSchema: { type: "string", pattern: "^a$" } as never }],
      tenant: "acme",
    });
    const r = await h.post(actionBody("broken", {}));
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({
      code: "INTERNAL",
      message: "action is not available on this host",
      requestId: expect.any(String),
    });
    expect(r.sequence).toEqual([
      {
        report: "binding/action",
        requestId: RID,
        error: expect.stringContaining('operation "broken" has an invalid paramsSchema'),
      },
    ]);
  });

  it("unsafe raw payload key: 422 with the unsafeKey issue, nothing recorded, the gate (ApprovalPort) is never consulted", async () => {
    const verify = vi.fn(async (): Promise<ApprovalVerifyResult> => ({ ok: true }));
    const h = rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(verify as ApprovalPort["verifyApproval"]),
      tenant: "acme",
    });
    const r = await h.post(
      '{"action":"delete","payload":{"nested":{"__proto__":{"polluted":true}}},"approval":"tok"}',
    );
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({
      code: "ACTION_PARAMS_INVALID",
      message: "action parameters failed validation",
      requestId: expect.any(String),
      issues: [
        {
          path: "nested.__proto__",
          code: "unsafeKey",
          message: 'the property name "__proto__" is not allowed',
        },
      ],
    });
    expect(r.sequence).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it("gate.check throws: report(binding/action) then action.denied with the descriptor tier, 503 INTERNAL, no invoke", async () => {
    const h = rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(async () => {
        throw new Error("approval store down");
      }),
      tenant: "acme",
    });
    const r = await h.post(actionBody("delete", {}, { approval: "tok" }));
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual({
      code: "INTERNAL",
      message: "action gate unavailable",
      requestId: expect.any(String),
    });
    expect(r.sequence).toEqual([
      { report: "binding/action", requestId: RID, error: "approval store down" },
      {
        audit: "denied",
        action: "delete",
        tier: "approve",
        reason: "action gate unavailable",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
    ]);
  });

  it("gate returns invalid: 422 with the schema issues, nothing recorded, no invoke", async () => {
    const h = rig({
      ops: [{ name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA }],
      tenant: "acme",
    });
    const r = await h.post(actionBody("annotate", { note: "way too long" }));
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({
      code: "ACTION_PARAMS_INVALID",
      message: "action parameters failed validation",
      requestId: expect.any(String),
      issues: [{ path: "note", code: "maxLength", message: "expected at most 5 characters" }],
    });
    expect(r.sequence).toEqual([]);
  });

  it("approvalRequired (confirm tier, not confirmed): action.approvalRequested, 403 APPROVAL_REQUIRED, no invoke", async () => {
    const h = rig({ ops: [{ name: "annotate", description: "d", tier: "confirm" }], tenant: "acme" });
    const r = await h.post(actionBody("annotate", {}));
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual({
      code: "APPROVAL_REQUIRED",
      message: "this action requires confirmation (confirmed: true)",
      requestId: expect.any(String),
      approval: {
        requestId: expect.any(String),
        action: "annotate",
        tier: "confirm",
        payloadHash: expect.any(String),
      },
    });
    expect(r.sequence).toEqual([
      {
        audit: "approvalRequested",
        action: "annotate",
        tier: "confirm",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
    ]);
  });

  it("approvalRequired (approve tier, no token): the token-required message, action.approvalRequested", async () => {
    const h = rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(async () => ({ ok: true })),
    });
    const r = await h.post(actionBody("delete", {}));
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("APPROVAL_REQUIRED");
    expect(r.body.error?.message).toBe("this action requires an approval token");
    expect(r.sequence).toEqual([
      {
        audit: "approvalRequested",
        action: "delete",
        tier: "approve",
        correlationId: RID,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
  });

  it("approvalRequired with a failing recorder: the audit failure is reported WITH the request id, wire unchanged", async () => {
    const h = rig({
      ops: [{ name: "annotate", description: "d", tier: "confirm" }],
      failingRecorder: "approvalRequested",
    });
    const r = await h.post(actionBody("annotate", {}));
    expect(r.status).toBe(403);
    expect(r.sequence).toEqual([
      {
        audit: "approvalRequested",
        action: "annotate",
        tier: "confirm",
        correlationId: RID,
        tenant: "(absent)",
        principal: "u1",
      },
      { report: "binding/action.audit", requestId: RID, error: "recorder approvalRequested down" },
    ]);
  });

  it("denied (token rejected by the ApprovalPort): action.denied with the port's reason, fixed client message, tenant bound into verifyApproval", async () => {
    const verify = vi.fn(
      async (_token: string, _req: object): Promise<ApprovalVerifyResult> => ({
        ok: false,
        reason: "approval already used",
      }),
    );
    const h = rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(verify as ApprovalPort["verifyApproval"]),
      tenant: "acme",
    });
    const r = await h.post(actionBody("delete", { id: 1 }, { approval: "tok" }));
    expect(r.status).toBe(403);
    expect(r.body.error).toEqual({
      code: "APPROVAL_REQUIRED",
      message: "approval token was rejected",
      requestId: expect.any(String),
      approval: {
        requestId: expect.any(String),
        action: "delete",
        tier: "approve",
        payloadHash: expect.any(String),
      },
    });
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "delete",
        tier: "approve",
        reason: "approval already used",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
    ]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toBe("tok");
    expect(verify.mock.calls[0]![1]).toEqual({
      action: "delete",
      payloadHash: expect.any(String),
      requesterId: "u1",
      tenant: "acme",
    });
  });

  it("denied (no ApprovalPort at all): action.denied with the fixed reason, that same reason as the client message", async () => {
    const h = rig({ ops: [{ name: "delete", description: "d", tier: "approve" }] });
    const r = await h.post(actionBody("delete", {}, { approval: "tok" }));
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("APPROVAL_REQUIRED");
    expect(r.body.error?.message).toBe("no ApprovalPort is configured for this host");
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "delete",
        tier: "approve",
        reason: "no ApprovalPort is configured for this host",
        correlationId: RID,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
  });

  it("proceed (auto tier): action.invoked recorded BEFORE domain.invoke, then 200", async () => {
    const h = rig({ ops: [{ name: "publish", description: "d" }], tenant: "acme" });
    const r = await h.post(actionBody("publish", { a: 1 }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ result: { ok: true, op: "publish", args: { a: 1 } } });
    expect(r.sequence).toEqual([
      {
        audit: "invoked",
        action: "publish",
        tier: "auto",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
      { invoke: "publish", args: { a: 1 } },
    ]);
  });

  it("proceed (approve tier, valid token): action.invoked then action.approved (grant), then domain.invoke", async () => {
    const h = rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(async (_token, req) => ({
        ok: true,
        grant: {
          action: "delete",
          payloadHash: req.payloadHash,
          approverId: "approver-1",
          requesterId: "u1",
          exp: 9999999999,
          jti: "jti-1",
        },
      })),
      tenant: "acme",
    });
    const r = await h.post(actionBody("delete", { id: 1 }, { approval: "tok" }));
    expect(r.status).toBe(200);
    expect(r.sequence).toEqual([
      {
        audit: "invoked",
        action: "delete",
        tier: "approve",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
      {
        audit: "approved",
        action: "delete",
        grant: "approver-1",
        correlationId: RID,
        tenant: "acme",
        principal: "u1",
      },
      { invoke: "delete", args: { id: 1 } },
    ]);
  });

  it("proceed with a failing recorder: the audit failure is reported WITH the request id and the invoke still runs (fail-open)", async () => {
    const h = rig({ ops: [{ name: "publish", description: "d" }], failingRecorder: "invoked" });
    const r = await h.post(actionBody("publish", {}));
    expect(r.status).toBe(200);
    expect(r.sequence).toEqual([
      {
        audit: "invoked",
        action: "publish",
        tier: "auto",
        correlationId: RID,
        tenant: "(absent)",
        principal: "u1",
      },
      { report: "binding/action.audit", requestId: RID, error: "recorder invoked down" },
      { invoke: "publish", args: {} },
    ]);
  });
});

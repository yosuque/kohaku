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
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { attachKohakuToMcpServer, type McpHostDeps } from "../src/index.js";

// Characterization of the governed-action gate sequence of the kohaku_action tool as the MCP profile runs it
// today, pinned BEFORE the sequence is extracted into host-core: for every outcome, the ordered log of
// observability-hook calls (endpoint, whether the correlation id was passed, error), audit-recorder records
// (type, action, tier, reason, correlation id, tenant presence, principal), the domain.invoke call and the
// wire result. These tests describe what the code does, not what it should do.

const NO_COMPOSE = {} as unknown as ComposeContext;
const CORR = "<correlationId>";
const CORRELATION_ID_RE = /^mcp:[^:]+:\d+$/;

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
  ops?: OperationDescriptor[];
  listOperationsError?: Error;
  approvals?: ApprovalPort;
  /** Makes the named recorder method reject (fail-open: must not change the wire result). */
  failingRecorder?: "invoked" | "denied" | "approvalRequested" | "approved";
}

async function rig(options: RigOptions) {
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
  const deps: McpHostDeps = {
    compose: NO_COMPOSE,
    domain,
    authz: allowAuthz,
    querySource: "sales",
    ...(options.approvals != null ? { approvals: options.approvals } : {}),
    onError: (info) => {
      log.push({
        report: info.endpoint,
        correlationId: "correlationId" in info ? info.correlationId : "(absent)",
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
  const server = new McpServer({ name: "kohaku-action-gate-sequence-test", version: "0.1.0" });
  attachKohakuToMcpServer(server, deps, {
    rendererHtml: "<!DOCTYPE html><html><body>renderer</body></html>",
  });
  const client = new Client({ name: "action-gate-sequence-test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  async function call(args: Record<string, unknown>) {
    // Let the attach-time operation-index validation (background, microtask-only) settle first, and take the
    // log baseline after it, so only the call's own sequence is asserted.
    await vi.waitFor(() => {
      if (options.listOperationsError != null || (options.ops ?? []).some((o) => o.name === "broken")) {
        expect(log.some((e) => e["report"] === "attach.operationIndex")).toBe(true);
      }
    });
    await new Promise((r) => setTimeout(r, 0));
    const baseline = log.length;
    const result = await client.callTool({
      name: "kohaku_action",
      arguments: { capability: "cap", ...args },
    });
    // Every correlation id of one call is the same value; it is normalized so the sequence can be compared.
    const raw = new Set<string>();
    const sequence = log.slice(baseline).map((e) => {
      const out: LogEntry = {};
      for (const [k, v] of Object.entries(e)) {
        if (k === "correlationId" && typeof v === "string" && v !== "(absent)") {
          expect(v).toMatch(CORRELATION_ID_RE);
          raw.add(v);
          out[k] = CORR;
        } else {
          out[k] = v;
        }
      }
      return out;
    });
    expect(raw.size).toBeLessThanOrEqual(1);
    return {
      isError: result.isError,
      text: (result.content as { text: string }[])[0]!.text,
      structured: result.structuredContent as
        | { error?: { code: string; message: string; issues?: unknown; approval?: unknown } }
        | undefined,
      sequence,
    };
  }
  return { call, close: () => client.close() };
}

function fakeApprovals(verify: ApprovalPort["verifyApproval"]): ApprovalPort {
  return {
    async issueApproval() {
      throw new Error("not used in these tests");
    },
    verifyApproval: verify,
  };
}

describe("kohaku_action: gate sequence, one test per outcome", () => {
  it("index throws: report(operationIndex) then action.denied tier auto, tool error, no invoke", async () => {
    const h = await rig({ listOperationsError: new Error("index down") });
    const r = await h.call({ action: "annotate", payload: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("operation index unavailable");
    expect(r.structured).toBeUndefined();
    expect(r.sequence).toEqual([
      { report: "kohaku_action.operationIndex", correlationId: CORR, error: "index down" },
      {
        audit: "denied",
        action: "annotate",
        tier: "auto",
        reason: "action gate unavailable",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
    await h.close();
  });

  it("undeclared action: action.denied tier auto only (no report), plain capability-denied tool error, no invoke", async () => {
    const h = await rig({ ops: [] });
    const r = await h.call({ action: "annotate", payload: { note: "hi" } });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("capability denied: action is not a declared DomainPort operation");
    expect(r.structured).toBeUndefined();
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "annotate",
        tier: "auto",
        reason: "action is not a declared DomainPort operation",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
    await h.close();
  });

  it("undeclared action with a failing recorder: the audit failure is reported WITH the correlation id", async () => {
    const h = await rig({ ops: [], failingRecorder: "denied" });
    const r = await h.call({ action: "annotate", payload: {} });
    expect(r.isError).toBe(true);
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "annotate",
        tier: "auto",
        reason: "action is not a declared DomainPort operation",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
      { report: "kohaku_action.audit", correlationId: CORR, error: "recorder denied down" },
    ]);
    await h.close();
  });

  it("schemaError entry: report(operationIndex) only (no audit record), tool error, no invoke", async () => {
    const h = await rig({
      ops: [{ name: "broken", description: "d", paramsSchema: { type: "string", pattern: "^a$" } as never }],
    });
    const r = await h.call({ action: "broken", payload: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("action parameter schema unavailable");
    expect(r.structured).toBeUndefined();
    expect(r.sequence).toEqual([
      {
        report: "kohaku_action.operationIndex",
        correlationId: CORR,
        error: expect.stringContaining('operation "broken" has an invalid paramsSchema'),
      },
    ]);
    await h.close();
  });

  it("unsafe raw payload key: structured ACTION_PARAMS_INVALID, nothing recorded, the gate (ApprovalPort) is never consulted", async () => {
    const verify = vi.fn(async (): Promise<ApprovalVerifyResult> => ({ ok: true }));
    const h = await rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(verify as ApprovalPort["verifyApproval"]),
    });
    // JSON.parse (unlike an object literal) makes "__proto__" a genuine own property, as on the wire.
    const payload = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
    const r = await h.call({ action: "delete", payload, approval: "tok" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("action parameters failed validation");
    expect(r.structured).toEqual({
      error: {
        code: "ACTION_PARAMS_INVALID",
        message: "action parameters failed validation",
        issues: [
          {
            path: "nested.__proto__",
            code: "unsafeKey",
            message: 'the property name "__proto__" is not allowed',
          },
        ],
      },
    });
    expect(r.sequence).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    await h.close();
  });

  it("gate.check throws: report(kohaku_action) then action.denied with the descriptor tier, tool error, no invoke", async () => {
    const h = await rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(async () => {
        throw new Error("approval store down");
      }),
    });
    const r = await h.call({ action: "delete", payload: {}, approval: "tok" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("action gate unavailable");
    expect(r.structured).toBeUndefined();
    expect(r.sequence).toEqual([
      { report: "kohaku_action", correlationId: CORR, error: "approval store down" },
      {
        audit: "denied",
        action: "delete",
        tier: "approve",
        reason: "action gate unavailable",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
    await h.close();
  });

  it("gate returns invalid: structured ACTION_PARAMS_INVALID with the schema issues, nothing recorded, no invoke", async () => {
    const h = await rig({ ops: [{ name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA }] });
    const r = await h.call({ action: "annotate", payload: { note: "way too long" } });
    expect(r.isError).toBe(true);
    expect(r.structured).toEqual({
      error: {
        code: "ACTION_PARAMS_INVALID",
        message: "action parameters failed validation",
        issues: [{ path: "note", code: "maxLength", message: "expected at most 5 characters" }],
      },
    });
    expect(r.sequence).toEqual([]);
    await h.close();
  });

  it("approvalRequired (confirm tier, not confirmed): action.approvalRequested, structured APPROVAL_REQUIRED, no invoke", async () => {
    const h = await rig({ ops: [{ name: "annotate", description: "d", tier: "confirm" }] });
    const r = await h.call({ action: "annotate", payload: {} });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("this action requires confirmation (confirmed: true)");
    expect(r.structured).toEqual({
      error: {
        code: "APPROVAL_REQUIRED",
        message: "this action requires confirmation (confirmed: true)",
        approval: {
          requestId: expect.any(String),
          action: "annotate",
          tier: "confirm",
          payloadHash: expect.any(String),
        },
      },
    });
    expect(r.sequence).toEqual([
      {
        audit: "approvalRequested",
        action: "annotate",
        tier: "confirm",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
    await h.close();
  });

  it("approvalRequired (approve tier, no token): the token-required message, action.approvalRequested", async () => {
    const h = await rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(async () => ({ ok: true })),
    });
    const r = await h.call({ action: "delete", payload: {} });
    expect(r.isError).toBe(true);
    expect(r.structured?.error?.code).toBe("APPROVAL_REQUIRED");
    expect(r.text).toBe("this action requires an approval token");
    expect(r.sequence).toEqual([
      {
        audit: "approvalRequested",
        action: "delete",
        tier: "approve",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
    await h.close();
  });

  it("approvalRequired with a failing recorder: the audit failure is reported WITHOUT a correlation id, wire unchanged", async () => {
    const h = await rig({
      ops: [{ name: "annotate", description: "d", tier: "confirm" }],
      failingRecorder: "approvalRequested",
    });
    const r = await h.call({ action: "annotate", payload: {} });
    expect(r.isError).toBe(true);
    expect(r.structured?.error?.code).toBe("APPROVAL_REQUIRED");
    expect(r.sequence).toEqual([
      {
        audit: "approvalRequested",
        action: "annotate",
        tier: "confirm",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
      { report: "kohaku_action.audit", correlationId: "(absent)", error: "recorder approvalRequested down" },
    ]);
    await h.close();
  });

  it("denied (token rejected by the ApprovalPort): action.denied with the port's reason, fixed client message, no tenant bound", async () => {
    const verify = vi.fn(
      async (_token: string, _req: object): Promise<ApprovalVerifyResult> => ({
        ok: false,
        reason: "approval already used",
      }),
    );
    const h = await rig({
      ops: [{ name: "delete", description: "d", tier: "approve" }],
      approvals: fakeApprovals(verify as ApprovalPort["verifyApproval"]),
    });
    const r = await h.call({ action: "delete", payload: { id: 1 }, approval: "tok" });
    expect(r.isError).toBe(true);
    expect(r.structured).toEqual({
      error: {
        code: "APPROVAL_REQUIRED",
        message: "approval token was rejected",
        approval: {
          requestId: expect.any(String),
          action: "delete",
          tier: "approve",
          payloadHash: expect.any(String),
        },
      },
    });
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "delete",
        tier: "approve",
        reason: "approval already used",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toBe("tok");
    expect(verify.mock.calls[0]![1]).toEqual({
      action: "delete",
      payloadHash: expect.any(String),
      requesterId: "u1",
      tenant: undefined,
    });
    await h.close();
  });

  it("denied (no ApprovalPort at all): action.denied with the fixed reason, that same reason as the client message", async () => {
    const h = await rig({ ops: [{ name: "delete", description: "d", tier: "approve" }] });
    const r = await h.call({ action: "delete", payload: {}, approval: "tok" });
    expect(r.isError).toBe(true);
    expect(r.structured?.error?.code).toBe("APPROVAL_REQUIRED");
    expect(r.text).toBe("no ApprovalPort is configured for this host");
    expect(r.sequence).toEqual([
      {
        audit: "denied",
        action: "delete",
        tier: "approve",
        reason: "no ApprovalPort is configured for this host",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
    ]);
    await h.close();
  });

  it("proceed (auto tier): action.invoked recorded BEFORE domain.invoke, then the result", async () => {
    const h = await rig({ ops: [{ name: "publish", description: "d" }] });
    const r = await h.call({ action: "publish", payload: { a: 1 } });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe("Executed action publish");
    expect(r.structured).toEqual({ result: { ok: true, op: "publish", args: { a: 1 } } });
    expect(r.sequence).toEqual([
      {
        audit: "invoked",
        action: "publish",
        tier: "auto",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
      { invoke: "publish", args: { a: 1 } },
    ]);
    await h.close();
  });

  it("proceed (approve tier, valid token): action.invoked then action.approved (grant), then domain.invoke", async () => {
    const h = await rig({
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
    });
    const r = await h.call({ action: "delete", payload: { id: 1 }, approval: "tok" });
    expect(r.isError).toBeFalsy();
    expect(r.sequence).toEqual([
      {
        audit: "invoked",
        action: "delete",
        tier: "approve",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
      {
        audit: "approved",
        action: "delete",
        grant: "approver-1",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
      { invoke: "delete", args: { id: 1 } },
    ]);
    await h.close();
  });

  it("proceed with a failing recorder: the audit failure is reported WITHOUT a correlation id and the invoke still runs (fail-open)", async () => {
    const h = await rig({ ops: [{ name: "publish", description: "d" }], failingRecorder: "invoked" });
    const r = await h.call({ action: "publish", payload: {} });
    expect(r.isError).toBeFalsy();
    expect(r.sequence).toEqual([
      {
        audit: "invoked",
        action: "publish",
        tier: "auto",
        correlationId: CORR,
        tenant: "(absent)",
        principal: "u1",
      },
      { report: "kohaku_action.audit", correlationId: "(absent)", error: "recorder invoked down" },
      { invoke: "publish", args: {} },
    ]);
    await h.close();
  });
});

import type { ApprovalPort, ApprovalVerifyResult, OperationDescriptor } from "@kohaku-ui/spec-core";
import { actionPayloadHash } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createActionGate } from "../src/action-gate.js";

const AUTO: OperationDescriptor = { name: "publish", description: "d" };
const CONFIRM: OperationDescriptor = { name: "annotate", description: "d", tier: "confirm" };
const APPROVE: OperationDescriptor = { name: "delete", description: "d", tier: "approve" };

const NOTE_SCHEMA = {
  type: "object" as const,
  properties: { note: { type: "string" as const, maxLength: 5 } },
  required: ["note"],
};

function fakeApprovals(verify: ApprovalPort["verifyApproval"]): ApprovalPort {
  return {
    async issueApproval() {
      throw new Error("not used in these tests");
    },
    verifyApproval: verify,
  };
}

describe("createActionGate: params validation (runs before tier gating)", () => {
  it("returns invalid with the exact issues, before ever consulting the tier", async () => {
    const gate = createActionGate();
    const result = await gate.check({
      descriptor: CONFIRM,
      paramsSchema: NOTE_SCHEMA,
      payload: { note: "way too long" },
      requesterId: "u1",
    });
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues).toEqual([
        { path: "note", code: "maxLength", message: "expected at most 5 characters" },
      ]);
    }
  });

  it("skips validation entirely when the descriptor declares no paramsSchema", async () => {
    const gate = createActionGate();
    const result = await gate.check({ descriptor: AUTO, payload: { anything: 1 }, requesterId: "u1" });
    expect(result.kind).toBe("allow");
  });
});

describe("createActionGate: tier 'auto'", () => {
  it("always allows once params validate", async () => {
    const gate = createActionGate();
    const result = await gate.check({ descriptor: AUTO, payload: {}, requesterId: "u1" });
    expect(result).toMatchObject({ kind: "allow", tier: "auto" });
  });
});

describe("createActionGate: tier 'confirm'", () => {
  it("requires confirmed: true, returning approvalRequired otherwise", async () => {
    const gate = createActionGate();
    const result = await gate.check({ descriptor: CONFIRM, payload: { note: "hi" }, requesterId: "u1" });
    expect(result.kind).toBe("approvalRequired");
    if (result.kind === "approvalRequired") {
      expect(result.tier).toBe("confirm");
      expect(typeof result.requestId).toBe("string");
      expect(result.requestId.length).toBeGreaterThan(0);
    }
  });

  it("allows once confirmed: true is present", async () => {
    const gate = createActionGate();
    const result = await gate.check({
      descriptor: CONFIRM,
      payload: { note: "hi" },
      confirmed: true,
      requesterId: "u1",
    });
    expect(result).toMatchObject({ kind: "allow", tier: "confirm" });
  });

  it("mints a fresh requestId on every approvalRequired check", async () => {
    const gate = createActionGate();
    const a = await gate.check({ descriptor: CONFIRM, payload: {}, requesterId: "u1" });
    const b = await gate.check({ descriptor: CONFIRM, payload: {}, requesterId: "u1" });
    if (a.kind === "approvalRequired" && b.kind === "approvalRequired") {
      expect(a.requestId).not.toBe(b.requestId);
    } else {
      throw new Error("expected both checks to be approvalRequired");
    }
  });
});

describe("createActionGate: tier 'approve'", () => {
  it("returns approvalRequired when no approval token is presented", async () => {
    const gate = createActionGate({ approvals: fakeApprovals(async () => ({ ok: true })) });
    const result = await gate.check({ descriptor: APPROVE, payload: {}, requesterId: "u1" });
    expect(result.kind).toBe("approvalRequired");
    if (result.kind === "approvalRequired") expect(result.tier).toBe("approve");
  });

  it("returns denied (not approvalRequired) when no ApprovalPort is configured at all", async () => {
    const gate = createActionGate();
    const result = await gate.check({
      descriptor: APPROVE,
      payload: {},
      approval: "some-token",
      requesterId: "u1",
    });
    expect(result.kind).toBe("denied");
  });

  it("allows and surfaces the grant when the approval verifies", async () => {
    const grant = {
      action: "delete",
      payloadHash: "sha256:x",
      approverId: "approver-1",
      requesterId: "u1",
      exp: 9999999999,
      jti: "jti-1",
    };
    const verify = vi.fn(
      async (
        _token: string,
        _req: { action: string; payloadHash: string; requesterId: string; tenant?: string },
      ): Promise<ApprovalVerifyResult> => ({ ok: true, grant }),
    );
    const gate = createActionGate({ approvals: fakeApprovals(verify) });
    const result = await gate.check({
      descriptor: APPROVE,
      payload: { id: 1 },
      approval: "token-abc",
      requesterId: "u1",
      tenant: "tenant-a",
    });
    expect(result.kind).toBe("allow");
    if (result.kind === "allow") expect(result.grant).toBe(grant);

    expect(verify).toHaveBeenCalledTimes(1);
    const [token, req] = verify.mock.calls[0]!;
    expect(token).toBe("token-abc");
    expect(req.action).toBe("delete");
    expect(req.requesterId).toBe("u1");
    expect(req.tenant).toBe("tenant-a");
    expect(req.payloadHash).toBe(await actionPayloadHash({ id: 1 }));
  });

  it("returns denied with the ApprovalPort's own reason when verification fails", async () => {
    const gate = createActionGate({
      approvals: fakeApprovals(async () => ({ ok: false, reason: "approval already used" })),
    });
    const result = await gate.check({
      descriptor: APPROVE,
      payload: {},
      approval: "token-abc",
      requesterId: "u1",
    });
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.reason).toBe("approval already used");
  });
});

describe("createActionGate: payloadHash", () => {
  it("is the same hash a caller would compute independently, for every outcome kind", async () => {
    const gate = createActionGate();
    const expected = await actionPayloadHash({ x: 1 });
    const allow = await gate.check({ descriptor: AUTO, payload: { x: 1 }, requesterId: "u1" });
    const approvalRequired = await gate.check({ descriptor: CONFIRM, payload: { x: 1 }, requesterId: "u1" });
    expect(allow.kind === "allow" && allow.payloadHash).toBe(expected);
    expect(approvalRequired.kind === "approvalRequired" && approvalRequired.payloadHash).toBe(expected);
  });
});

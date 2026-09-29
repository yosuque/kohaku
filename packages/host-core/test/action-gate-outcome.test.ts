import type { ApprovalGrant, Principal } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import type { ActionAuditRecorder } from "../src/action-audit.js";
import type { ActionGateResult } from "../src/action-gate.js";
import {
  APPROVAL_TOKEN_REQUIRED_MESSAGE,
  CONFIRMATION_REQUIRED_MESSAGE,
  recordActionGateResult,
  recordUndeclaredActionDenial,
  UNDECLARED_ACTION_MESSAGE,
} from "../src/action-gate-outcome.js";

const PRINCIPAL: Principal = { id: "u1" };
const HASH = `sha256:${"a".repeat(64)}`;

function fakeRecorder(): ActionAuditRecorder & {
  [K in keyof ActionAuditRecorder]: ReturnType<typeof vi.fn>;
} {
  return {
    invoked: vi.fn(async () => {}),
    denied: vi.fn(async () => {}),
    approvalRequested: vi.fn(async () => {}),
    approved: vi.fn(async () => {}),
  };
}

function ctxOf(recorder: ActionAuditRecorder | undefined, extra: { tenant?: string } = {}) {
  return {
    recorder,
    action: "annotate",
    payload: { note: "hi" },
    principal: PRINCIPAL,
    correlationId: "req-1",
    report: vi.fn(async () => {}),
    ...extra,
  };
}

describe("recordActionGateResult", () => {
  it("invalid: records nothing and returns the issues", async () => {
    const recorder = fakeRecorder();
    const issues = [{ path: "note", code: "maxLength", message: "expected at most 5 characters" }];
    const outcome = await recordActionGateResult({ kind: "invalid", issues }, ctxOf(recorder));
    expect(outcome).toEqual({ kind: "invalid", issues });
    for (const fn of Object.values(recorder)) expect(fn).not.toHaveBeenCalled();
  });

  it("approvalRequired (confirm): records action.approvalRequested and returns the confirmation message + descriptor", async () => {
    const recorder = fakeRecorder();
    const gate: ActionGateResult = {
      kind: "approvalRequired",
      tier: "confirm",
      payloadHash: HASH,
      requestId: "r1",
    };
    const outcome = await recordActionGateResult(gate, ctxOf(recorder, { tenant: "t1" }));
    expect(outcome).toEqual({
      kind: "approvalRequired",
      message: CONFIRMATION_REQUIRED_MESSAGE,
      approval: { requestId: "r1", action: "annotate", tier: "confirm", payloadHash: HASH },
    });
    expect(recorder.approvalRequested).toHaveBeenCalledWith({
      action: "annotate",
      payloadHash: HASH,
      tier: "confirm",
      requestId: "r1",
      payload: { note: "hi" },
      principal: PRINCIPAL,
      tenant: "t1",
      correlationId: "req-1",
    });
  });

  it("approvalRequired (approve): uses the approval-token message; a profile with no tenant passes none", async () => {
    const recorder = fakeRecorder();
    const gate: ActionGateResult = {
      kind: "approvalRequired",
      tier: "approve",
      payloadHash: HASH,
      requestId: "r2",
    };
    const outcome = await recordActionGateResult(gate, ctxOf(recorder));
    expect(outcome).toMatchObject({ kind: "approvalRequired", message: APPROVAL_TOKEN_REQUIRED_MESSAGE });
    expect(recorder.approvalRequested.mock.calls[0]![0]).not.toHaveProperty("tenant");
  });

  it("denied: records action.denied and returns the reason as the message (same wire variant as approvalRequired)", async () => {
    const recorder = fakeRecorder();
    const gate: ActionGateResult = {
      kind: "denied",
      tier: "approve",
      payloadHash: HASH,
      requestId: "r3",
      reason: "approval expired",
    };
    const outcome = await recordActionGateResult(gate, ctxOf(recorder));
    expect(outcome).toEqual({
      kind: "approvalRequired",
      message: "approval expired",
      approval: { requestId: "r3", action: "annotate", tier: "approve", payloadHash: HASH },
    });
    expect(recorder.denied).toHaveBeenCalledWith(
      expect.objectContaining({ action: "annotate", tier: "approve", reason: "approval expired" }),
    );
  });

  it("allow: records action.invoked, plus action.approved when a grant was consumed", async () => {
    const recorder = fakeRecorder();
    const grant = { approverId: "boss" } as unknown as ApprovalGrant;
    const outcome = await recordActionGateResult(
      { kind: "allow", tier: "approve", payloadHash: HASH, grant },
      ctxOf(recorder),
    );
    expect(outcome).toEqual({ kind: "proceed" });
    expect(recorder.invoked).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "approve", payloadHash: HASH }),
    );
    expect(recorder.approved).toHaveBeenCalledWith(expect.objectContaining({ grant, payloadHash: HASH }));
  });

  it("allow without a grant records only action.invoked", async () => {
    const recorder = fakeRecorder();
    await recordActionGateResult({ kind: "allow", tier: "auto", payloadHash: HASH }, ctxOf(recorder));
    expect(recorder.invoked).toHaveBeenCalledTimes(1);
    expect(recorder.approved).not.toHaveBeenCalled();
  });

  it("recording is fail-open: a throwing recorder is reported, and the outcome is unchanged", async () => {
    const recorder = fakeRecorder();
    recorder.denied.mockRejectedValue(new Error("sink down"));
    const ctx = ctxOf(recorder);
    const outcome = await recordActionGateResult(
      { kind: "denied", tier: "approve", payloadHash: HASH, requestId: "r4", reason: "nope" },
      ctx,
    );
    expect(outcome.kind).toBe("approvalRequired");
    expect(ctx.report).toHaveBeenCalledTimes(1);
  });

  it("with no recorder wired it still returns the outcome", async () => {
    const outcome = await recordActionGateResult(
      { kind: "allow", tier: "auto", payloadHash: HASH },
      ctxOf(undefined),
    );
    expect(outcome).toEqual({ kind: "proceed" });
  });
});

describe("recordUndeclaredActionDenial", () => {
  it("records action.denied with tier auto, the undeclared-action reason and the payload hash", async () => {
    const recorder = fakeRecorder();
    await recordUndeclaredActionDenial(ctxOf(recorder, { tenant: "t1" }));
    expect(recorder.denied).toHaveBeenCalledWith({
      action: "annotate",
      payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      tier: "auto",
      reason: UNDECLARED_ACTION_MESSAGE,
      principal: PRINCIPAL,
      tenant: "t1",
      correlationId: "req-1",
    });
  });

  it("is fail-open", async () => {
    const recorder = fakeRecorder();
    recorder.denied.mockRejectedValue(new Error("sink down"));
    const ctx = ctxOf(recorder);
    await expect(recordUndeclaredActionDenial(ctx)).resolves.toBeUndefined();
    expect(ctx.report).toHaveBeenCalledTimes(1);
  });
});

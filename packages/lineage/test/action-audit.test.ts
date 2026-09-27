import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createActionAuditRecorder, createLineage } from "../src/index.js";

function memoryStorage(): StoragePort & { events: LineageEventRecord[] } {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  return {
    events,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
      events.push(event);
    },
    async listLineage(filter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      return result.slice(-(filter.limit ?? 200));
    },
    async getPromotionState(id) {
      return states.get(id) ?? null;
    },
    async putPromotionState(state) {
      states.set(state.artifactId, state);
    },
    async listPromotionStates() {
      return [...states.values()];
    },
    async getFixation() {
      return null;
    },
    async putFixation() {},
    async listFixations() {
      return [];
    },
  };
}

describe("Lineage.actionInvoked / actionDenied / actionApprovalRequested / actionApproved", () => {
  it("actionInvoked records the full payload and omits correlationId when unset", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.actionInvoked(
      { action: "annotate", payloadHash: "sha256:aaa", tier: "auto" },
      { kind: "user", id: "u1" },
      "tenant-a",
    );

    const event = storage.events[0]!;
    expect(event.type).toBe("action.invoked");
    expect(event.actor).toEqual({ kind: "user", id: "u1" });
    expect(event.tenant).toBe("tenant-a");
    expect(event.payload).toEqual({ action: "annotate", payloadHash: "sha256:aaa", tier: "auto" });
  });

  it("actionInvoked includes correlationId when given", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.actionInvoked({
      action: "annotate",
      payloadHash: "sha256:aaa",
      tier: "confirm",
      correlationId: "corr-1",
    });

    expect(storage.events[0]!.payload["correlationId"]).toBe("corr-1");
  });

  it("actionDenied records the reason", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.actionDenied({
      action: "delete",
      payloadHash: "sha256:bbb",
      tier: "approve",
      reason: "approval already used",
    });

    const event = storage.events[0]!;
    expect(event.type).toBe("action.denied");
    expect(event.payload).toEqual({
      action: "delete",
      payloadHash: "sha256:bbb",
      tier: "approve",
      reason: "approval already used",
    });
  });

  it("actionApprovalRequested omits payload by default and includes it when given", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.actionApprovalRequested({
      action: "delete",
      payloadHash: "sha256:ccc",
      tier: "approve",
      requestId: "req-1",
    });
    expect(storage.events[0]!.payload).toEqual({
      action: "delete",
      payloadHash: "sha256:ccc",
      tier: "approve",
      requestId: "req-1",
    });

    await lineage.actionApprovalRequested({
      action: "delete",
      payloadHash: "sha256:ccc",
      tier: "approve",
      requestId: "req-2",
      payload: { id: 1 },
    });
    expect(storage.events[1]!.payload["payload"]).toEqual({ id: 1 });
  });

  it("actionApproved records approverId and requesterId", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.actionApproved({
      action: "delete",
      payloadHash: "sha256:ddd",
      approverId: "approver-1",
      requesterId: "requester-1",
    });

    const event = storage.events[0]!;
    expect(event.type).toBe("action.approved");
    expect(event.payload).toEqual({
      action: "delete",
      payloadHash: "sha256:ddd",
      approverId: "approver-1",
      requesterId: "requester-1",
    });
  });

  it("is retrievable via list({type: [...]})", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    await lineage.actionInvoked({ action: "a", payloadHash: "sha256:x", tier: "auto" });
    await lineage.record("view.composed", { specHash: "irrelevant" });

    const events = await lineage.list({ type: ["action.invoked"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("action.invoked");
  });
});

describe("createActionAuditRecorder", () => {
  const PRINCIPAL = { id: "u1", roles: ["user"] };

  it("invoked() stamps actor as {kind: 'user', id: principal.id}", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    const recorder = createActionAuditRecorder(lineage);

    await recorder.invoked({
      action: "annotate",
      payloadHash: "sha256:x",
      tier: "auto",
      principal: PRINCIPAL,
      tenant: "tenant-a",
    });

    const event = storage.events[0]!;
    expect(event.type).toBe("action.invoked");
    expect(event.actor).toEqual({ kind: "user", id: "u1" });
    expect(event.tenant).toBe("tenant-a");
  });

  it("denied() forwards the reason", async () => {
    const storage = memoryStorage();
    const recorder = createActionAuditRecorder(createLineage({ storage }));

    await recorder.denied({
      action: "delete",
      payloadHash: "sha256:x",
      tier: "approve",
      reason: "approval expired",
      principal: PRINCIPAL,
    });

    expect(storage.events[0]!.payload["reason"]).toBe("approval expired");
  });

  it("approvalRequested() omits the payload by default", async () => {
    const storage = memoryStorage();
    const recorder = createActionAuditRecorder(createLineage({ storage }));

    await recorder.approvalRequested({
      action: "annotate",
      payloadHash: "sha256:x",
      tier: "confirm",
      requestId: "req-1",
      payload: { note: "secret note" },
      principal: PRINCIPAL,
    });

    expect(storage.events[0]!.payload["payload"]).toBeUndefined();
  });

  it("approvalRequested() includes the payload when recordPayload: true", async () => {
    const storage = memoryStorage();
    const recorder = createActionAuditRecorder(createLineage({ storage }), { recordPayload: true });

    await recorder.approvalRequested({
      action: "annotate",
      payloadHash: "sha256:x",
      tier: "confirm",
      requestId: "req-1",
      payload: { note: "visible to the approver" },
      principal: PRINCIPAL,
    });

    expect(storage.events[0]!.payload["payload"]).toEqual({ note: "visible to the approver" });
  });

  it("approved() records the grant's approverId/requesterId", async () => {
    const storage = memoryStorage();
    const recorder = createActionAuditRecorder(createLineage({ storage }));

    await recorder.approved({
      action: "delete",
      payloadHash: "sha256:x",
      grant: {
        action: "delete",
        payloadHash: "sha256:x",
        approverId: "approver-1",
        requesterId: "u1",
        exp: 9999999999,
        jti: "jti-1",
      },
      principal: PRINCIPAL,
    });

    const event = storage.events[0]!;
    expect(event.type).toBe("action.approved");
    expect(event.payload).toMatchObject({ approverId: "approver-1", requesterId: "u1" });
  });
});

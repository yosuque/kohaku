import type { DomainPort, OperationDescriptor } from "@kohaku-ui/spec-core";
import { actionPayloadHash } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import type { ActionAuditRecorder } from "../src/action-audit.js";
import { GATED_READ_MESSAGE, isGatedOperation, runGatedReadGuard } from "../src/gated-read.js";
import { createOperationIndex, type OperationIndexEntry } from "../src/operation-index.js";

function entryOf(descriptor: OperationDescriptor): OperationIndexEntry {
  return { descriptor };
}

function indexOf(...ops: OperationDescriptor[]) {
  const domain: DomainPort = {
    async listOperations() {
      return ops;
    },
    async invoke() {
      return {};
    },
  };
  return createOperationIndex(domain);
}

function recorderWith(denied: ReturnType<typeof vi.fn>): ActionAuditRecorder {
  return {
    invoked: async () => {},
    denied: denied as unknown as ActionAuditRecorder["denied"],
    approvalRequested: async () => {},
    approved: async () => {},
  };
}

const PRINCIPAL = { id: "u1", roles: ["user"] };

describe("isGatedOperation", () => {
  it("is true only for tier confirm / approve", () => {
    expect(isGatedOperation(entryOf({ name: "a", description: "d", tier: "approve" }))).toBe(true);
    expect(isGatedOperation(entryOf({ name: "a", description: "d", tier: "confirm" }))).toBe(true);
    expect(isGatedOperation(entryOf({ name: "a", description: "d", tier: "auto" }))).toBe(false);
    expect(isGatedOperation(entryOf({ name: "a", description: "d" }))).toBe(false);
  });
});

describe("runGatedReadGuard", () => {
  function run(
    index: ReturnType<typeof indexOf>,
    action: string,
    denied: ReturnType<typeof vi.fn>,
    reportIndexFailure = vi.fn(async () => {}),
    report = vi.fn(async () => {}),
  ) {
    return runGatedReadGuard({
      operationIndex: index,
      audit: {
        recorder: recorderWith(denied),
        action,
        payload: { fy: "2026" },
        principal: PRINCIPAL,
        tenant: "t1",
        correlationId: "req-1",
        report,
      },
      reportIndexFailure,
    });
  }

  it("a gated operation: outcome gated with its tier, audited as action.denied with the fixed reason", async () => {
    const denied = vi.fn(async () => {});
    const outcome = await run(indexOf({ name: "purge", description: "d", tier: "approve" }), "purge", denied);
    expect(outcome).toEqual({ kind: "gated", tier: "approve" });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied).toHaveBeenCalledWith({
      action: "purge",
      payloadHash: await actionPayloadHash({ fy: "2026" }),
      tier: "approve",
      reason: GATED_READ_MESSAGE,
      principal: PRINCIPAL,
      tenant: "t1",
      correlationId: "req-1",
    });
  });

  it("a tier-less operation, a tier auto operation and an operation absent from the index are readable and not audited", async () => {
    const denied = vi.fn(async () => {});
    const index = indexOf(
      { name: "records", description: "d" },
      { name: "trend", description: "d", tier: "auto" },
    );
    expect(await run(index, "records", denied)).toEqual({ kind: "readable" });
    expect(await run(index, "trend", denied)).toEqual({ kind: "readable" });
    expect(await run(index, "unlisted", denied)).toEqual({ kind: "readable" });
    expect(denied).not.toHaveBeenCalled();
  });

  it("a recorder that throws is reported and does not change the outcome (fail-open)", async () => {
    const boom = new Error("audit down (test)");
    const denied = vi.fn(async () => {
      throw boom;
    });
    const report = vi.fn(async () => {});
    const outcome = await run(
      indexOf({ name: "purge", description: "d", tier: "confirm" }),
      "purge",
      denied,
      undefined,
      report,
    );
    expect(outcome).toEqual({ kind: "gated", tier: "confirm" });
    expect(report).toHaveBeenCalledWith(boom);
  });

  it("an unreadable index: indexUnavailable, reported, audited as action.denied tier auto (fail-closed)", async () => {
    const boom = new Error("list failed (test)");
    const denied = vi.fn(async () => {});
    const reportIndexFailure = vi.fn(async () => {});
    const outcome = await run(
      async () => {
        throw boom;
      },
      "records",
      denied,
      reportIndexFailure,
    );
    expect(outcome).toEqual({ kind: "indexUnavailable" });
    expect(reportIndexFailure).toHaveBeenCalledWith(boom);
    expect(denied).toHaveBeenCalledWith(
      expect.objectContaining({ action: "records", tier: "auto", reason: "action gate unavailable" }),
    );
  });

  it("a recorder-less audit context is a no-op (no recorder wired)", async () => {
    const outcome = await runGatedReadGuard({
      operationIndex: indexOf({ name: "purge", description: "d", tier: "approve" }),
      audit: {
        recorder: undefined,
        action: "purge",
        payload: {},
        principal: PRINCIPAL,
        correlationId: "req-1",
        report: async () => {},
      },
      reportIndexFailure: async () => {},
    });
    expect(outcome).toEqual({ kind: "gated", tier: "approve" });
  });
});
